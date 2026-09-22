/* ------------------------------------------------------------------ *
 *  Injetado na aba de visualização (a página /usuario/reels/).
 *
 *  Faz duas coisas: abre um reel ao acaso automaticamente, e captura as
 *  teclas S / D / A para devolver a decisão ao modal. A página em si é
 *  carregada pelo navegador como qualquer outra, então nada aqui passa
 *  pelos endpoints de API que estavam devolvendo 400 e 429.
 * ------------------------------------------------------------------ */

(function () {

if (window.__naoSeguidoresReels) {
    window.__naoSeguidoresReels.restart();
    return;
}

const bar = document.createElement('div');
bar.className = 'ns-reels-bar';
bar.innerHTML =
    '<div class="ns-who"><span class="ns-user">carregando…</span>' +
        '<span class="ns-pos"></span></div>' +
    '<div class="ns-keys">' +
        '<button class="ns-sound" title="Ligar/desligar som (M)">🔊</button>' +
        '<button class="ns-key" data-act="another"><b>←</b> outro</button>' +
        '<button class="ns-key" data-act="next"><b>↓</b> avançar</button>' +
        '<button class="ns-key ns-danger" data-act="unfollow"><b>→</b> unfollow</button>' +
    '</div>' +
    '<div class="ns-note"></div>';

document.documentElement.appendChild(bar);

const soundEl = bar.querySelector('.ns-sound');
const userEl = bar.querySelector('.ns-user');
const posEl  = bar.querySelector('.ns-pos');
const noteEl = bar.querySelector('.ns-note');

let sent = false;
let hunting = 0;

function note(text) { noteEl.innerText = text || ''; }

function send(action) {
    if (sent) return;                       // uma decisão por perfil
    sent = true;
    bar.classList.add('ns-locked');
    note(action === 'unfollow' ? 'removendo…' : 'próximo…');
    try { chrome.runtime.sendMessage({ type: 'ns:action', action: action }); } catch (e) {}
}

/* ------------------------------ som ------------------------------- *
 * O navegador obriga autoplay a comecar mudo, e o player do Instagram tem
 * estado proprio: mexer so no elemento <video> nao adianta, ele remuta no
 * render seguinte. Entao fazemos os dois -- desmutamos o elemento E
 * clicamos no botao de audio do proprio Instagram, que fica salvo como
 * preferencia. Como o React remonta o player, insistimos por alguns
 * segundos apos cada troca de reel.                                     */

// padrao e som ligado; se o usuario mutar na mao, respeita ate ele religar
let wantSound = true;
try { wantSound = localStorage.getItem('nao-seguidores:som') !== 'off'; } catch (e) {}

let audioTimer = null;

function rememberSound() {
    try { localStorage.setItem('nao-seguidores:som', wantSound ? 'on' : 'off'); } catch (e) {}
}

function paintSound() {
    soundEl.innerText = wantSound ? '🔊' : '🔇';
    soundEl.classList.toggle('ns-off', !wantSound);
}

function instagramMuteButton() {
    const icon = document.querySelector(
        'svg[aria-label="Áudio está desativado"], svg[aria-label="Audio is muted"],' +
        'svg[aria-label="Ativar som"], svg[aria-label="Unmute"], svg[aria-label="Ativar áudio"]'
    );
    return icon ? icon.closest('button, [role="button"], div[tabindex]') : null;
}

function applySound() {
    const videos = document.querySelectorAll('video');
    for (let i = 0; i < videos.length; i++) {
        const v = videos[i];
        if (v.muted === wantSound) v.muted = !wantSound;
        if (wantSound && v.volume === 0) v.volume = 1;
    }

    // o seletor so casa com o icone no estado MUDO, entao clicar aqui nunca
    // desliga um som que ja esta ligado
    if (wantSound) {
        const btn = instagramMuteButton();
        if (btn) btn.click();
    }
}

function keepSound(ms) {
    clearTimeout(audioTimer);
    applySound();

    const until = Date.now() + (ms || 8000);
    (function again() {
        audioTimer = setTimeout(function () {
            applySound();
            if (Date.now() < until) again();
        }, 350);
    })();
}

soundEl.addEventListener('click', function (ev) {
    ev.stopPropagation();
    wantSound = !wantSound;
    rememberSound();
    paintSound();
    keepSound(2000);
});

/* ---- abre um reel qualquer da grade, sem pedir nada para a API ---- */

function openRandomReel(attempt) {
    attempt = attempt || 0;
    if (!hunting) return;

    // já estamos dentro de um reel/post aberto: nada a fazer
    if (/\/(reel|reels|p)\/[^/]+/.test(location.pathname)) { note(''); keepSound(); return; }

    const links = document.querySelectorAll(
        'main a[href*="/reel/"], main a[href*="/p/"], section a[href*="/reel/"], section a[href*="/p/"]'
    );

    if (!links.length) {
        if (attempt > 25) {                 // ~10s: perfil sem reels visíveis
            note('sem reels');
            return;
        }
        setTimeout(function () { openRandomReel(attempt + 1); }, 400);
        return;
    }

    // sorteia entre os primeiros da grade, que são os mais recentes
    const pool = Math.min(links.length, 9);
    const pick = links[Math.floor(Math.random() * pool)];
    note('');
    pick.click();
    keepSound();               // o player acabou de nascer: insiste no som
}

/* ----------------------------- teclado ---------------------------- */

function onKey(ev) {
    const tag = ev.target && ev.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (ev.target && ev.target.isContentEditable)) return;
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return;

    const k = (ev.key || '').toLowerCase();
    let action = null;

    if (k === 'm') {
        ev.preventDefault();
        wantSound = !wantSound;
        rememberSound();
        paintSound();
        keepSound(2000);
        return;
    }

    if (k === 'arrowdown' || k === 's') action = 'next';
    else if (k === 'arrowright' || k === 'd') action = 'unfollow';
    else if (k === 'arrowleft' || k === 'a') action = 'another';
    else return;

    ev.preventDefault();
    ev.stopPropagation();
    send(action);
}

document.addEventListener('keydown', onKey, true);

bar.addEventListener('click', function (ev) {
    const btn = ev.target.closest('.ns-key');
    if (btn) send(btn.dataset.act);
});

/* ---------------------------- arranque ---------------------------- */

function start() {
    sent = false;
    hunting = 1;
    bar.classList.remove('ns-locked');
    note('procurando…');
    paintSound();
    keepSound();

    try {
        chrome.runtime.sendMessage({ type: 'ns:viewer-info' }, function (res) {
            if (!res || !res.ok || !res.info) return;
            userEl.innerText = '@' + res.info.username;
            posEl.innerText = res.info.position || '';
        });
    } catch (e) {}

    openRandomReel(0);
}

window.__naoSeguidoresReels = { restart: start };
start();

})();
