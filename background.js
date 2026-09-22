/* ------------------------------------------------------------------ *
 *  Não Seguidores — service worker
 *
 *  Além de injetar a extensão, faz o papel de central telefônica do
 *  "Scroll das Contas": a aba do modal (controller) manda abrir um perfil,
 *  este arquivo reaproveita UMA aba de visualização (viewer) e injeta nela
 *  os controles; as teclas apertadas lá voltam para o controller.
 *
 *  O estado mora em chrome.storage.session porque um service worker MV3 é
 *  desligado a qualquer momento — variável solta some junto.
 * ------------------------------------------------------------------ */

const VIEWER_FILES = { css: ['reelsControls.css'], js: ['reelsControls.js'] };

async function getState() {
    const box = await chrome.storage.session.get('ns');
    return box.ns || { controllerTabId: null, viewerTabId: null, info: null };
}

async function setState(patch) {
    const state = await getState();
    const next = Object.assign(state, patch);
    await chrome.storage.session.set({ ns: next });
    return next;
}

/* ---------------------- abertura da extensão ---------------------- */

chrome.action.onClicked.addListener(function () {
    chrome.tabs.create({ url: 'https://www.instagram.com' }, function (tab) {
        chrome.tabs.onUpdated.addListener(function listener(tabId, changeInfo) {
            if (tabId !== tab.id || changeInfo.status !== 'complete') return;
            chrome.tabs.onUpdated.removeListener(listener);

            chrome.scripting.insertCSS({ files: ['contentScript.css'], target: { tabId: tab.id } });
            chrome.scripting.executeScript({ files: ['contentScript.js'], target: { tabId: tab.id } });
        });
    });
});

/* ------------------------- aba de visualização -------------------- */

function reelsUrl(username) {
    return 'https://www.instagram.com/' + encodeURIComponent(username) + '/reels/';
}

async function openViewer(info) {
    const state = await getState();
    // cache-buster: reabrir o MESMO perfil precisa recarregar de verdade,
    // senão o Chrome ignora o update e o reel sorteado não muda
    const base = info.url || reelsUrl(info.username);
    const url = base + (base.indexOf('?') === -1 ? '?' : '&') + 'ns=' + Date.now();

    await setState({ info: info });

    if (state.viewerTabId !== null && state.viewerTabId !== undefined) {
        try {
            await chrome.tabs.update(state.viewerTabId, { url: url, active: true });
            return state.viewerTabId;
        } catch (e) {
            await setState({ viewerTabId: null });
        }
    }

    const tab = await chrome.tabs.create({ url: url, active: true });
    await setState({ viewerTabId: tab.id });
    return tab.id;
}

async function closeViewer() {
    const state = await getState();
    if (state.viewerTabId === null || state.viewerTabId === undefined) return;
    try { await chrome.tabs.remove(state.viewerTabId); } catch (e) {}
    await setState({ viewerTabId: null, info: null });
}

// injeta os controles assim que a aba de visualização termina de carregar
chrome.tabs.onUpdated.addListener(async function (tabId, changeInfo) {
    if (changeInfo.status !== 'complete') return;

    const state = await getState();
    if (tabId !== state.viewerTabId) return;

    // stories abrem o player sozinhos e não têm fila de triagem:
    // injetar a barra de controles ali só atrapalharia
    if (state.info && state.info.mode === 'story') return;

    try {
        await chrome.scripting.insertCSS({ target: { tabId: tabId }, files: VIEWER_FILES.css });
        await chrome.scripting.executeScript({ target: { tabId: tabId }, files: VIEWER_FILES.js });
    } catch (e) {
        // pode falhar se o usuário navegou para fora do instagram.com
    }
});

// usuário fechou a aba na mão: avisa o controller para não ficar dessincronizado
chrome.tabs.onRemoved.addListener(async function (tabId) {
    const state = await getState();

    if (tabId === state.viewerTabId) {
        await setState({ viewerTabId: null, info: null });
        if (state.controllerTabId !== null && state.controllerTabId !== undefined) {
            try { chrome.tabs.sendMessage(state.controllerTabId, { type: 'ns:viewer-closed' }); } catch (e) {}
        }
    }

    if (tabId === state.controllerTabId) {
        await setState({ controllerTabId: null });
        closeViewer();
    }
});

/* ---------------------------- mensagens --------------------------- */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;

    if (msg.type === 'ns:register') {
        setState({ controllerTabId: sender.tab ? sender.tab.id : null })
            .then(function () { sendResponse({ ok: true }); });
        return true;
    }

    if (msg.type === 'ns:open-viewer') {
        openViewer(msg.info)
            .then(function (tabId) { sendResponse({ ok: true, tabId: tabId }); })
            .catch(function (e) { sendResponse({ ok: false, error: String(e) }); });
        return true;
    }

    if (msg.type === 'ns:close-viewer') {
        closeViewer().then(function () { sendResponse({ ok: true }); });
        return true;
    }

    // o script injetado pergunta de quem é o perfil que está na tela
    if (msg.type === 'ns:viewer-info') {
        getState().then(function (state) { sendResponse({ ok: true, info: state.info }); });
        return true;
    }

    // tecla apertada na aba de visualização → volta para o modal
    if (msg.type === 'ns:action') {
        getState().then(function (state) {
            if (state.controllerTabId === null || state.controllerTabId === undefined) {
                sendResponse({ ok: false });
                return;
            }
            try {
                chrome.tabs.sendMessage(state.controllerTabId, {
                    type: 'ns:action',
                    action: msg.action
                });
            } catch (e) {}
            sendResponse({ ok: true });
        });
        return true;
    }

    // trazer o modal de volta para a frente
    if (msg.type === 'ns:focus-controller') {
        getState().then(function (state) {
            if (state.controllerTabId !== null && state.controllerTabId !== undefined) {
                try { chrome.tabs.update(state.controllerTabId, { active: true }); } catch (e) {}
            }
            sendResponse({ ok: true });
        });
        return true;
    }
});
