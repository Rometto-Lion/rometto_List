(async function () {
  // ===== НАСТРОЙКИ (секретов здесь нет, этот файл можно публиковать) =====
  const GITHUB_OWNER = 'Rometto-Lion';
  const GITHUB_REPO = 'rometto_List';
  const CONFIG_PATH = 'config.json';
  // SHA-256 файла rometto.key, строчными буквами (см. инструкцию)
  const EXPECTED_KEY_HASH = 'cd372fb85148700fa88095e3492d3f9f5beb43e555e5ff26d95f5a6adc36f8e6';
  // Кодовое слово: напечатай его на любой странице сайта (вне полей ввода)
  const SECRET_PHRASE = 'rometto';
  const SAVE_DELAY_MS = 800;

  const TOKEN_KEY = 'rm_admin_gh_token';
  const DRAFT_KEY = 'rm_admin_latest_config';

  let saveTimer = null;
  let pendingChanges = {};
  let phraseBuffer = '';

  // ===== Утилиты =====
  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin);
  }

  function base64ToUtf8(b64) {
    const bin = atob(b64.replace(/\s/g, ''));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  function isTypingTarget(el) {
    if (!el) return false;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT' || el.isContentEditable;
  }

  // ===== 1. Применение сохранённых настроек (видят все посетители) =====
  async function applySiteConfig() {
    let config = null;

    // Пока GitHub Pages обновляет статику, админ видит свою свежую версию из сессии
    const draft = sessionStorage.getItem(DRAFT_KEY);
    if (draft) {
      config = JSON.parse(draft);
    } else {
      try {
        const res = await fetch(`/${CONFIG_PATH}?v=${Date.now()}`, { cache: 'no-store' });
        if (res.ok) config = await res.json();
      } catch (e) {
        return; // config.json ещё не создан — остаются значения из HTML
      }
    }
    if (!config) return;

    document.querySelectorAll('[data-edit]').forEach((el) => {
      const key = el.dataset.edit;
      if (config[key] === undefined) return;

      if (el.tagName === 'IMG') {
        el.src = config[key];
      } else if (el.tagName === 'A' && el.dataset.editAttr === 'href') {
        el.href = config[key];
      } else {
        el.textContent = config[key];
      }
    });
  }

  // ===== 2. Окно входа по файлу-ключу =====
  function openDropModal() {
    if (document.getElementById('rm-key-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'rm-key-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;z-index:99999;font-family:sans-serif;';
    modal.innerHTML = `
      <div id="rm-dropzone" style="width:360px;padding:32px;background:#16161a;border:2px dashed #6c5ce7;border-radius:16px;color:#fff;text-align:center;cursor:pointer;">
        <div style="font-size:18px;font-weight:600;margin-bottom:8px;">Вход по файлу-ключу</div>
        <div style="font-size:13px;color:#a0a0b0;">Перетащи сюда файл-ключ или нажми, чтобы выбрать</div>
        <div id="rm-login-status" style="margin-top:14px;font-size:13px;color:#ff7675;"></div>
        <input type="file" id="rm-file-input" style="display:none;" />
      </div>`;
    document.body.appendChild(modal);

    const dropzone = modal.querySelector('#rm-dropzone');
    const fileInput = modal.querySelector('#rm-file-input');
    const statusEl = modal.querySelector('#rm-login-status');

    const close = () => {
      modal.remove();
      document.removeEventListener('keydown', onEsc);
    };
    const onEsc = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onEsc);

    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.style.borderColor = '#00cec9';
    });
    dropzone.addEventListener('dragleave', () => {
      dropzone.style.borderColor = '#6c5ce7';
    });
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer.files[0]) verifyKeyFile(e.dataTransfer.files[0], statusEl, close);
    });
    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) verifyKeyFile(fileInput.files[0], statusEl, close);
    });
  }

  async function verifyKeyFile(file, statusEl, close) {
    statusEl.style.color = '#a0a0b0';
    statusEl.textContent = 'Проверка файла-ключа...';

    const buffer = await file.arrayBuffer();
    const hash = await sha256Hex(buffer);

    if (hash !== EXPECTED_KEY_HASH.toLowerCase()) {
      statusEl.style.color = '#ff7675';
      statusEl.textContent = 'Неверный файл-ключ';
      return;
    }

    const token = new TextDecoder().decode(buffer).trim();
    sessionStorage.setItem(TOKEN_KEY, token);
    close();
    history.replaceState(null, '', location.pathname + location.search);
    enableAdminMode(token);
  }

  // ===== 3. GitHub API: чтение и запись config.json =====
  function apiUrl() {
    return `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${CONFIG_PATH}`;
  }

  function ghHeaders(token) {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };
  }

  async function readRemoteConfig(token) {
    const res = await fetch(`${apiUrl()}?t=${Date.now()}`, { headers: ghHeaders(token) });
    if (res.status === 404) return { config: {}, sha: null };
    if (!res.ok) throw new Error('read failed');
    const file = await res.json();
    let config = {};
    try { config = JSON.parse(base64ToUtf8(file.content)); } catch (e) {}
    return { config, sha: file.sha };
  }

  async function commitChanges(token, updates) {
    // До двух попыток: при конфликте (409) заново читаем файл и сливаем правки
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { config: current, sha } = await readRemoteConfig(token);
      const merged = { ...current, ...updates };

      const res = await fetch(apiUrl(), {
        method: 'PUT',
        headers: ghHeaders(token),
        body: JSON.stringify({
          message: 'Update site config via admin panel',
          content: utf8ToBase64(JSON.stringify(merged, null, 2)),
          sha: sha || undefined
        })
      });

      if (res.ok) {
        sessionStorage.setItem(DRAFT_KEY, JSON.stringify(merged));
        return;
      }
      if (res.status !== 409) break;
    }
    throw new Error('save failed');
  }

  // ===== 4. Панель администратора и редактирование =====
  function enableAdminMode(token) {
    if (document.getElementById('rm-admin-bar')) return;

    const bar = document.createElement('div');
    bar.id = 'rm-admin-bar';
    bar.style.cssText = 'position:fixed;bottom:16px;right:16px;background:#16161a;color:#fff;padding:12px 18px;border-radius:12px;border:1px solid #2e2e38;box-shadow:0 10px 30px rgba(0,0,0,.45);display:flex;align-items:center;gap:14px;z-index:99998;font-family:sans-serif;font-size:14px;';
    bar.innerHTML = `
      <span>С возвращением, <b>Рометто</b>!</span>
      <span id="rm-save-badge" style="color:#00b894;font-size:12px;">Готово к правкам</span>
      <button id="rm-logout-btn" style="background:#2d2d37;color:#ccc;border:none;padding:5px 10px;border-radius:6px;cursor:pointer;font-size:12px;">Выйти</button>`;
    document.body.appendChild(bar);

    const badge = bar.querySelector('#rm-save-badge');

    bar.querySelector('#rm-logout-btn').addEventListener('click', () => {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(DRAFT_KEY);
      location.reload();
    });

    // Карточки на главной — это ссылки; в режиме правки клик по тексту не должен переходить
    document.addEventListener('click', (e) => {
      if (e.target.closest && e.target.closest('[data-edit]') && e.target.closest('a')) {
        e.preventDefault();
      }
    }, true);

    document.querySelectorAll('[data-edit]').forEach((el) => {
      if (el.tagName === 'IMG') return;
      el.contentEditable = 'true';
      el.style.outline = '1px dashed rgba(108, 92, 231, 0.6)';
      el.style.outlineOffset = '4px';
    });

    // Один обработчик на всю страницу: ловит правки в любом data-edit элементе
    document.addEventListener('input', (e) => {
      const el = e.target.closest ? e.target.closest('[data-edit]') : null;
      if (!el || el.tagName === 'IMG') return;

      pendingChanges[el.dataset.edit] = el.textContent.trim();
      badge.style.color = '#fdcb6e';
      badge.textContent = 'Сохранение...';

      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        const payload = { ...pendingChanges };
        pendingChanges = {};
        try {
          await commitChanges(token, payload);
          badge.style.color = '#00b894';
          badge.textContent = 'Сохранено ✓';
        } catch (err) {
          // Вернём несохранённое в очередь, чтобы не потерять
          pendingChanges = { ...payload, ...pendingChanges };
          badge.style.color = '#ff7675';
          badge.textContent = 'Ошибка сохранения';
        }
      }, SAVE_DELAY_MS);
    });
  }

  // ===== Запуск =====
  await applySiteConfig();

  const savedToken = sessionStorage.getItem(TOKEN_KEY);
  if (savedToken) {
    enableAdminMode(savedToken);
  } else if (location.hash === '#admin') {
    openDropModal();
  }

  // Кодовое слово «rometto» вне полей ввода открывает окно входа
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(document.activeElement)) return;
    if (e.key.length !== 1) return;

    phraseBuffer = (phraseBuffer + e.key.toLowerCase()).slice(-SECRET_PHRASE.length);
    if (phraseBuffer === SECRET_PHRASE) {
      phraseBuffer = '';
      if (!sessionStorage.getItem(TOKEN_KEY)) openDropModal();
    }
  });
})();
