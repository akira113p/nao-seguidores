function init() {

/* ------------------------------------------------------------------ *
 *  Não Seguidores
 *  - descoberta rápida via friendships/show_many (sem baixar a lista
 *    completa de seguidores)
 *  - resultado separado em duas abas: Pessoas (<3k) e Contas (>=3k)
 *  - unfollow sem trava rígida, apenas alerta a cada 15
 *  - governador de requisições com ritmo humano, pausas e backoff
 * ------------------------------------------------------------------ */

const SPINNER = '<svg aria-label="Carregando..." class=" _abdx" viewBox="0 0 100 100"><rect fill="#555555" height="6" opacity="0" rx="3" ry="3" transform="rotate(-90 50 50)" width="25" x="72" y="47"></rect><rect fill="#555555" height="6" opacity="0.08333333333333333" rx="3" ry="3" transform="rotate(-60 50 50)" width="25" x="72" y="47"></rect><rect fill="#555555" height="6" opacity="0.16666666666666666" rx="3" ry="3" transform="rotate(-30 50 50)" width="25" x="72" y="47"></rect><rect fill="#555555" height="6" opacity="0.25" rx="3" ry="3" transform="rotate(0 50 50)" width="25" x="72" y="47"></rect><rect fill="#555555" height="6" opacity="0.3333333333333333" rx="3" ry="3" transform="rotate(30 50 50)" width="25" x="72" y="47"></rect><rect fill="#555555" height="6" opacity="0.4166666666666667" rx="3" ry="3" transform="rotate(60 50 50)" width="25" x="72" y="47"></rect><rect fill="#555555" height="6" opacity="0.5" rx="3" ry="3" transform="rotate(90 50 50)" width="25" x="72" y="47"></rect><rect fill="#555555" height="6" opacity="0.5833333333333334" rx="3" ry="3" transform="rotate(120 50 50)" width="25" x="72" y="47"></rect><rect fill="#555555" height="6" opacity="0.6666666666666666" rx="3" ry="3" transform="rotate(150 50 50)" width="25" x="72" y="47"></rect><rect fill="#555555" height="6" opacity="0.75" rx="3" ry="3" transform="rotate(180 50 50)" width="25" x="72" y="47"></rect><rect fill="#555555" height="6" opacity="0.8333333333333334" rx="3" ry="3" transform="rotate(210 50 50)" width="25" x="72" y="47"></rect><rect fill="#555555" height="6" opacity="0.9166666666666666" rx="3" ry="3" transform="rotate(240 50 50)" width="25" x="72" y="47"></rect></svg>';

const CFG = {
    listPageSize:      100,   // usuários por página; cai sozinho se o IG recusar
    listPageSizeMin:   25,
    statusBatch:       100,   // ids por chamada de show_many
    followerCut:       3000,  // divisor entre "Pessoas" e "Contas"
    unfollowAlertAt:   15,    // alerta (não bloqueia) a cada N unfollows
    unfollowGapMin:    1400,  // espaçamento humano entre unfollows (ms)
    unfollowGapMax:    3400,
    enrichLanes:       10,    // conexoes paralelas ao classificar seguidores
    enrichGap:         140,   // intervalo inicial entre consultas de perfil (ms)
    enrichGapMin:      70,    // piso: ate onde acelera se o IG nao reclamar
                              // MENOR = mais rapido e mais arriscado
    cacheMax:          4000,
    legacyFollowerCap: 10000  // limite que só vale para o método antigo
};

/* ------------------------------ sessão ---------------------------- */

const pageHtml = document.body.innerHTML;

function cookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
}

function fromHtml(re) {
    const m = pageHtml.match(re);
    if (!m) return null;
    return m[1] !== undefined ? m[1] : m[0];
}

const viewerId = cookie('ds_user_id')
    || fromHtml(/\\?"viewerId\\?":\\?"(\w+)\\?"/i)
    || fromHtml(/\\?"appScopedIdentity\\?":\\?"(\w+)\\?"/i);

const csrfToken = cookie('csrftoken') || fromHtml(/(?<="csrf_token":").+?(?=")/i);
const appId     = fromHtml(/(?<="X-IG-App-ID":").+?(?=")/i) || '936619743392459';
const ajaxHash  = fromHtml(/(?<="rollout_hash":").+?(?=")/i);

const headersGet = { 'X-Asbd-Id': '129477', 'X-Requested-With': 'XMLHttpRequest' };
const headersPost = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Asbd-Id': '129477'
};

if (appId) { headersGet['X-Ig-App-Id'] = appId; headersPost['X-Ig-App-Id'] = appId; }
if (csrfToken) { headersGet['X-Csrftoken'] = csrfToken; headersPost['X-Csrftoken'] = csrfToken; }
if (ajaxHash) headersPost['X-Instagram-Ajax'] = ajaxHash;

let wwwClaim = null;
try { wwwClaim = sessionStorage.getItem('www-claim-v2'); } catch (e) {}
if (wwwClaim) { headersGet['X-Ig-Www-Claim'] = wwwClaim; headersPost['X-Ig-Www-Claim'] = wwwClaim; }

// o Instagram renova esse token a cada resposta; manter atualizado deixa a
// sessão coerente com a do app e evita que ela destoe de um acesso normal
function absorbClaim(res) {
    const claim = res.headers.get('x-ig-set-www-claim');
    if (!claim || claim === wwwClaim) return;
    wwwClaim = claim;
    headersGet['X-Ig-Www-Claim'] = claim;
    headersPost['X-Ig-Www-Claim'] = claim;
    try { sessionStorage.setItem('www-claim-v2', claim); } catch (e) {}
}

/* ------------------------------- UI ------------------------------- */

document.body.insertAdjacentHTML('afterbegin',
    '<div class="modal"><div class="modal-dialog"><div class="modal-content"><div class="modal-body">' +
    '<div class="p-4">' +
        '<div class="h1">Não Seguidores' +
            '<span class="ver">v' + chrome.runtime.getManifest().version + '</span></div>' +
        '<div class="warn"></div>' +
        '<div class="status"></div>' +
        '<div class="message"></div>' +
    '</div>' +
    '<div class="tabs" hidden>' +
        '<button class="tab active" data-tab="pessoas">Pessoas <span class="count">0</span></button>' +
        '<button class="tab" data-tab="contas">Contas <span class="count">0</span></button>' +
        '<button class="tab" data-tab="amigos">Amigos <span class="count">0</span></button>' +
        '<button class="tab" data-tab="scroll">Scroll <span class="count">0</span></button>' +
        '<button class="tab" data-tab="stories">Stories <span class="count">0</span></button>' +
    '</div>' +
    '<div class="tabhint" hidden>Pessoas: menos de 3.000 seguidores &middot; Contas: 3.000 ou mais</div>' +
    '<div class="result">' +
        '<div class="tab-panel" data-panel="pessoas"></div>' +
        '<div class="tab-panel" data-panel="contas" hidden></div>' +
        '<div class="tab-panel" data-panel="amigos" hidden>' +
            '<div class="fr-intro">' +
                '<p>Quem você segue <b>e</b> também te segue de volta.</p>' +
                '<button class="btn-primary fr-go">Mostrar contas</button>' +
                '<div class="fr-note"></div>' +
            '</div>' +
            '<div class="fr-list"></div>' +
        '</div>' +
        '<div class="tab-panel scroller" data-panel="scroll" hidden></div>' +
        '<div class="tab-panel" data-panel="stories" hidden>' +
            '<div class="st-head">' +
                '<button class="btn-primary st-go">Carregar stories</button>' +
                '<div class="st-note"></div>' +
            '</div>' +
            '<div class="st-pick st-grupo">' +
                '<button data-g="pessoas" class="active">Pessoas <b>0</b></button>' +
                '<button data-g="contas">Contas <b>0</b></button>' +
            '</div>' +
            '<div class="st-pick st-estado">' +
                '<button data-s="novos" class="active">Não vistos <b>0</b></button>' +
                '<button data-s="vistos">Já vistos <b>0</b></button>' +
            '</div>' +
            '<div class="st-list"></div>' +
        '</div>' +
    '</div>' +
    '</div></div></div></div>');

document.body.style.overflowY = 'hidden';

const modal     = document.querySelector('.modal');
const statusEl  = document.querySelector('.modal .status');
const messageEl = document.querySelector('.modal .message');
const warnEl    = document.querySelector('.modal .warn');
const tabsEl    = document.querySelector('.modal .tabs');
const tabHintEl = document.querySelector('.modal .tabhint');
const panels = {
    pessoas: document.querySelector('.tab-panel[data-panel="pessoas"]'),
    contas:  document.querySelector('.tab-panel[data-panel="contas"]'),
    amigos:  document.querySelector('.tab-panel[data-panel="amigos"]'),
    scroll:  document.querySelector('.tab-panel[data-panel="scroll"]'),
    stories: document.querySelector('.tab-panel[data-panel="stories"]')
};

// declarados aqui e nao junto da secao Amigos: refreshTabCounts referencia
// friendsList e pode rodar antes daquele ponto do arquivo
const friendsList = panels.amigos.querySelector('.fr-list');
const friendsNote = panels.amigos.querySelector('.fr-note');
const friendsBtn  = panels.amigos.querySelector('.fr-go');

let playBtn = null;
let running = false;
let progress = 0;
let selfFollowers = 0;
let selfFollowing = 0;
let unfollowCount = 0;

function note(kind, text) {
    messageEl.innerHTML = text ? '<span class="circle ' + kind + '"></span> ' + text : '';
}

function showWarn(html) { warnEl.innerHTML = html; }

function resetButton(label) {
    if (!playBtn) return;
    playBtn.disabled = false;
    playBtn.innerText = label || 'Carregar';
}

function setProgress(value) {
    if (value <= progress || value >= 1) return;
    progress = value;
    playBtn.innerText = 'Carregando (' + Math.round(value * 100) + '%)';
}

function refreshTabCounts() {
    tabsEl.querySelector('[data-tab="pessoas"] .count').innerText = panels.pessoas.childElementCount;
    tabsEl.querySelector('[data-tab="contas"] .count').innerText  = panels.contas.childElementCount;
    tabsEl.querySelector('[data-tab="scroll"] .count').innerText   = panels.contas.childElementCount;
    tabsEl.querySelector('[data-tab="amigos"] .count').innerText   = friendsList.childElementCount;
    tabsEl.querySelector('[data-tab="stories"] .count').innerText  =
        storiesData.filter(function (x) { return x.novo; }).length;
}

function revealTabs() {
    tabsEl.hidden = false;
    tabHintEl.hidden = false;
}

function selectTab(name) {
    tabsEl.querySelectorAll('.tab').forEach(function (t) {
        t.classList.toggle('active', t.dataset.tab === name);
    });
    panels.pessoas.hidden = name !== 'pessoas';
    panels.contas.hidden  = name !== 'contas';
    panels.amigos.hidden  = name !== 'amigos';
    panels.scroll.hidden  = name !== 'scroll';
    panels.stories.hidden = name !== 'stories';

    document.querySelector('.modal-content').classList.toggle('in-scroll', name === 'scroll');

    if (name === 'scroll') openScroller();
    else closeScroller();
}

/* ------------------------ ritmo / anti-bloqueio -------------------- */

// Todas as chamadas passam por uma fila única de atraso. Como o intervalo é
// serializado, aumentar o paralelismo não aumenta a taxa de requisições.
const gov = {
    base: 900,
    floor: 700,
    ceiling: 20000,
    sinceBreak: 0,
    nextBreak: 12 + Math.floor(Math.random() * 9),
    streak: 0
};

let paceChain = Promise.resolve();

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// soma de 3 aleatórios: distribuição em sino, em vez do padrão plano de random()
function humanJitter(ms) {
    const bell = (Math.random() + Math.random() + Math.random()) / 3;
    return Math.round(ms * (0.55 + bell * 0.95));
}

function pace() {
    const step = paceChain.then(async function () {
        let wait = humanJitter(gov.base);
        if (++gov.sinceBreak >= gov.nextBreak) {
            gov.sinceBreak = 0;
            gov.nextBreak = 12 + Math.floor(Math.random() * 9);
            wait += 3500 + Math.random() * 5500;
        }
        await sleep(wait);
    });
    paceChain = step.catch(function () {});
    return step;
}

function penalize() {
    gov.streak = 0;
    gov.base = Math.min(gov.ceiling, Math.round(gov.base * 2.2));
}

function reward() {
    if (++gov.streak < 8) return;
    gov.streak = 0;
    gov.base = Math.max(gov.floor, Math.round(gov.base * 0.85));
}

/* ----------------------------- rede ------------------------------- */

function fail(message, fatal) {
    const err = new Error(message);
    err.userMessage = message;
    err.fatal = !!fatal;
    return err;
}

function httpError(status) {
    if (status === 429) {
        const limit = fail('O Instagram limitou temporariamente as consultas. Aguarde alguns minutos e tente novamente.');
        limit.rateLimited = true;
        return limit;
    }
    if (status === 401 || status === 403) return fail('O Instagram recusou a consulta. Faça login novamente e tente de novo.', true);
    const err = fail('Parece que o Instagram está bloqueando a requisição (ERRO-01, status ' + status + ')');
    // endpoint removido/alterado: vale tentar o método alternativo
    if (status === 400 || status === 404) err.unsupported = true;
    if (status >= 500) err.rateLimited = true;
    return err;
}

// Le o corpo como texto antes de tentar o parse: quando o Instagram devolve
// HTML (login, bloqueio, pagina de erro) precisamos ver o que veio, e nao so
// saber que o JSON.parse falhou.
async function readJson(res) {
    const url = res.url || '';
    if (/\/accounts\/login|\/login\//.test(url)) throw fail('Sua sessão expirou. Faça login no Instagram e tente novamente.', true);
    if (/\/challenge/.test(url)) throw fail('O Instagram pediu uma verificação de segurança. Abra o Instagram, confirme a verificação e tente de novo.', true);

    const contentType = res.headers.get('content-type') || '(sem content-type)';
    let text = '';
    try {
        text = await res.text();
    } catch (e) {
        throw fail('A resposta do Instagram foi interrompida no meio. Tente novamente.');
    }

    try {
        return JSON.parse(text);
    } catch (e) {
        console.error('[Não Seguidores] resposta não-JSON', {
            url: url,
            status: res.status,
            contentType: contentType,
            tamanho: text.length,
            inicio: text.slice(0, 500)
        });

        const html = /html/i.test(contentType) || /^\s*</.test(text);
        if (html && /accounts\/login/.test(text.slice(0, 2000))) {
            throw fail('O Instagram respondeu com a página de login. Recarregue a aba, confirme que está logado e tente de novo.', true);
        }

        const err = fail('O Instagram devolveu ' + (text.length === 0 ? 'uma resposta vazia' : contentType) +
            ' em vez de JSON (status ' + res.status + '). Detalhes no Console do navegador (F12).');
        // HTML com status 200 = o roteador do app serviu a pagina inteira
        // porque essa rota de API nao existe nesse host. Nao adianta insistir,
        // e sim tentar outro caminho.
        if (html) err.unsupported = true;
        throw err;
    }
}

// respostas 200 que na prática são bloqueio disfarçado
function guardMessage(data) {
    if (!data || typeof data !== 'object') return null;
    if (data.require_login) return 'Sua sessão expirou. Faça login no Instagram e tente novamente.';
    if (data.checkpoint_required || data.checkpoint_url) return 'O Instagram pediu uma verificação de segurança. Abra o Instagram, confirme a verificação e tente de novo.';
    if (data.spam || data.feedback_required) return 'O Instagram sinalizou as ações como automáticas. Pare por algumas horas antes de continuar.';
    return null;
}

async function api(url, options, attempts) {
    attempts = attempts || 3;
    let lastError = null;

    for (let attempt = 0; attempt < attempts; attempt++) {
        if (!running) return null;

        if (attempt > 0) {
            const throttled = !!(lastError && lastError.rateLimited);
            // pausa longa serve para limite de taxa; resposta malformada nao
            // melhora esperando 40s, entao tenta de novo rapido
            if (throttled) penalize();
            const cooldown = throttled
                ? 30000 * attempt + Math.random() * 20000
                : 3000 + Math.random() * 3000;
            note('warning', (throttled ? 'O Instagram pediu uma pausa.' : 'Resposta inesperada do Instagram.') +
                ' Tentando de novo em ' + Math.round(cooldown / 1000) + 's...');
            await sleep(cooldown);
            if (!running) return null;
            note('', '');
        }

        await pace();
        if (!running) return null;

        let res;
        try {
            res = await fetch(url, Object.assign({
                credentials: 'include',
                mode: 'cors',
                headers: (options && options.method === 'POST') ? headersPost : headersGet
            }, options || {}));
        } catch (e) {
            lastError = fail('Não foi possível falar com o Instagram. Verifique sua conexão e tente novamente.');
            continue;
        }

        absorbClaim(res);

        if (res.status === 429 || res.status >= 500) { lastError = httpError(res.status); continue; }
        if (res.status !== 200) throw httpError(res.status);

        let data;
        try {
            data = await readJson(res);
        } catch (e) {
            if (e && e.fatal) throw e;
            lastError = e;
            continue;
        }

        const guard = guardMessage(data);
        if (guard) throw fail(guard, true);

        reward();
        return data;
    }

    throw lastError;
}

/* --------------------------- dados -------------------------------- */

function toAccount(u) {
    const st = u.friendship_status || null;
    return {
        id: String(u.pk !== undefined && u.pk !== null ? u.pk : u.pk_id),
        username: u.username,
        fullName: u.full_name || '',
        pic: u.profile_pic_url,
        // as vezes a propria listagem ja diz se a pessoa te segue de volta;
        // quando diz, nao precisamos de nenhuma consulta extra
        followsBack: st && typeof st.followed_by === 'boolean' ? st.followed_by : null,
        followers: null,
        el: null
    };
}

// percorre followers/following paginando
async function walkList(kind, onPage) {
    const seenIds = new Set();
    const rows = [];
    const seenCursors = new Set();
    let cursor = '';
    let pageSize = CFG.listPageSize;

    while (running) {
        let url = 'https://www.instagram.com/api/v1/friendships/' + viewerId + '/' + kind + '/?count=' + pageSize;
        url += kind === 'followers' ? '&search_surface=follow_list_page' : '&order=date_followed_latest';
        if (cursor) url += '&max_id=' + encodeURIComponent(cursor);

        let data;
        try {
            data = await api(url, null, 2);
        } catch (e) {
            // páginas grandes são o primeiro suspeito quando o IG devolve lixo:
            // encolhe e tenta o mesmo ponto da lista de novo antes de desistir
            if (!e || e.fatal || pageSize <= CFG.listPageSizeMin) throw e;
            pageSize = Math.max(CFG.listPageSizeMin, Math.floor(pageSize / 2));
            console.warn('[Não Seguidores] reduzindo count para ' + pageSize + ' após falha:', e.message);
            note('warning', 'Reduzindo o tamanho das páginas para ' + pageSize + ' e tentando novamente...');
            continue;
        }
        if (!data) break;

        const users = data.users || [];
        const fresh = [];
        users.forEach(function (u) {
            const acc = toAccount(u);
            if (!acc.id || acc.id === 'undefined' || seenIds.has(acc.id)) return;
            seenIds.add(acc.id);
            rows.push(acc);
            fresh.push(acc);
        });

        if (onPage) await onPage(fresh);

        const next = data.next_max_id !== undefined && data.next_max_id !== null ? String(data.next_max_id) : '';
        if (!next || users.length === 0 || seenCursors.has(next)) break;
        seenCursors.add(next);
        cursor = next;
    }

    return { ids: seenIds, rows: rows };
}

// O show_many nao esta no mesmo host em todas as contas: em www o roteador do
// app devolve HTML. Tenta os candidatos e memoriza o que respondeu JSON.
const SHOW_MANY_URLS = [
    'https://i.instagram.com/api/v1/friendships/show_many/',
    'https://www.instagram.com/api/v1/friendships/show_many/',
    'https://www.instagram.com/web/friendships/show_many/'
];

const SHOW_MANY_MEMO = 'nao-seguidores:show-many';

let showManyUrl = null;

// Quando nenhum host responde, nao adianta repetir as 3 tentativas em toda
// varredura: falham de novo e ainda deixam requisicoes com erro no historico.
function showManyMemo() {
    try {
        const raw = JSON.parse(localStorage.getItem(SHOW_MANY_MEMO) || 'null');
        if (!raw || Date.now() - raw.at > 24 * 60 * 60 * 1000) return null;
        return raw;
    } catch (e) { return null; }
}

function rememberShowMany(url) {
    try { localStorage.setItem(SHOW_MANY_MEMO, JSON.stringify({ url: url, at: Date.now() })); } catch (e) {}
}

// pergunta em lote quem segue de volta: dispensa baixar a lista de seguidores
async function askFollowsBack(accounts) {
    const body = 'user_ids=' + encodeURIComponent(accounts.map(function (a) { return a.id; }).join(','));

    if (!showManyUrl) {
        const memo = showManyMemo();
        if (memo && !memo.url) {
            const skip = fail('show_many indisponível (memorizado nas últimas 24h)');
            skip.unsupported = true;
            throw skip;
        }
        if (memo && memo.url) showManyUrl = memo.url;
    }

    const candidates = showManyUrl ? [showManyUrl] : SHOW_MANY_URLS;
    let lastError = null;

    for (let i = 0; i < candidates.length; i++) {
        const url = candidates[i];
        let data;

        try {
            // 1 tentativa por host: falhar rapido para chegar ao proximo
            data = await api(url, { method: 'POST', body: body }, 1);
        } catch (e) {
            if (e && e.fatal) throw e;
            lastError = e;
            console.warn('[Não Seguidores] show_many falhou em ' + url + ': ' + e.message);
            continue;
        }

        if (!data) return null;

        const statuses = data.friendship_statuses;
        if (!statuses || typeof statuses !== 'object') {
            lastError = fail('show_many respondeu sem friendship_statuses');
            lastError.unsupported = true;
            console.warn('[Não Seguidores] ' + url + ' respondeu JSON sem friendship_statuses', data);
            continue;
        }

        if (!showManyUrl) {
            showManyUrl = url;
            rememberShowMany(url);
            console.info('[Não Seguidores] show_many ativo em ' + url);
        }

        return accounts.filter(function (a) {
            const st = statuses[a.id];
            return st ? !st.followed_by : false;
        });
    }

    rememberShowMany(null);
    const err = lastError || fail('show_many indisponível');
    err.unsupported = true;
    throw err;
}

/* ---------------------- cache de perfis --------------------------- */

/* Guardamos o perfil inteiro, nao so a contagem: o mesmo dado que classifica
 * em Pessoas/Contas tambem alimenta o cartao de preview no hover.
 * Formato: { t: quando, c: seguidores, f: seguindo, m: posts,
 *            b: bio, v: verificado, p: privado }                        */

const CACHE_KEY = 'nao-seguidores:perfis';
const DAY = 24 * 60 * 60 * 1000;

let cache = {};
try {
    cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {};
    localStorage.removeItem('nao-seguidores:follower-count');   // formato antigo, so contagem
} catch (e) { cache = {}; }

// Quanto mais longe do corte de 3.000, menos importa a contagem estar exata:
// uma conta de 150 seguidores nao vira "Conta" tao cedo, entao o dado dela
// pode envelhecer meses. Perto do corte, expira rapido. Isso corta a maior
// parte das reconsultas sem errar a classificacao.
function cacheTtl(followers) {
    const distance = Math.abs(followers - CFG.followerCut);
    if (distance < 500)  return 3 * DAY;
    if (distance < 2000) return 10 * DAY;
    return 45 * DAY;
}

function cacheGet(id) {
    const entry = cache[id];
    if (!entry || typeof entry.c !== 'number' || !entry.t) { delete cache[id]; return null; }
    if (Date.now() - entry.t > cacheTtl(entry.c)) { delete cache[id]; return null; }
    return entry;
}

function cacheSet(id, entry) { cache[id] = entry; }

function cacheFlush() {
    try {
        const keys = Object.keys(cache);
        if (keys.length > CFG.cacheMax) {
            keys.sort(function (a, b) {
                return (cache[a].t || 0) - (cache[b].t || 0);
            }).slice(0, keys.length - CFG.cacheMax).forEach(function (k) { delete cache[k]; });
        }
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch (e) {
        // cota estourada: joga metade fora e tenta de novo
        try {
            const keys = Object.keys(cache).sort(function (a, b) {
                return (cache[a].t || 0) - (cache[b].t || 0);
            });
            keys.slice(0, Math.ceil(keys.length / 2)).forEach(function (k) { delete cache[k]; });
            localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
        } catch (e2) {}
    }
}

/* ----------------------- renderização ----------------------------- */

// trunca em vez de arredondar: 2.999 seguidores nao pode virar "3,0mil"
// e cair na leitura de "Conta" quando a extensao o classificou como Pessoa
function oneDecimal(value) {
    const cut = Math.floor(value * 10) / 10;
    return cut % 1 === 0 ? String(cut) : cut.toFixed(1).replace('.', ',');
}

function shortNumber(n) {
    if (n >= 1000000) return oneDecimal(n / 1000000) + 'M';
    if (n >= 1000) return oneDecimal(n / 1000) + 'mil';
    return String(n);
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

const rowsById = new Map();

function renderRow(acc, target) {
    const row = document.createElement('div');
    row.className = 'row flex items-center justify-between';
    row.dataset.id = acc.id;
    row.innerHTML =
        '<a href="https://www.instagram.com/' + encodeURIComponent(acc.username) + '/" target="_blank" class="flex items-center">' +
            '<img src="' + escapeHtml(acc.pic || '') + '" loading="lazy">' +
            '<span class="flex flex-col">' +
                '<span>@' + escapeHtml(acc.username) + '</span>' +
                '<span class="sub">' + escapeHtml(acc.fullName) + '</span>' +
            '</span>' +
        '</a>' +
        '<div class="flex items-center">' +
            '<span class="seen" title="Já revisado no Scroll">✓</span>' +
            '<span class="followers" title="Seguidores">…</span>' +
            '<button class="btn-sm unfollow" data-id="' + escapeHtml(acc.id) + '">Seguindo</button>' +
        '</div>';
    acc.el = row;
    acc.movable = !target;          // só a triagem (Pessoas/Contas) se reordena
    rowsById.set(acc.id, acc);
    (target || panels.pessoas).appendChild(row);
    paintReviewMark(acc);
    return row;
}

function classify(acc, profile) {
    acc.profile = profile || null;
    const followers = profile ? profile.c : null;
    acc.followers = followers;
    if (!acc.el) return;

    const badge = acc.el.querySelector('.followers');
    if (badge) badge.innerText = followers === null ? '—' : shortNumber(followers);

    // Só as linhas da triagem migram entre Pessoas e Contas. As da aba Amigos
    // ficam onde estão: sem esta guarda, saber a contagem de seguidores (por
    // hover ou por cache) arrancava a linha da lista em que ela estava.
    if (acc.movable) {
        const target = (followers !== null && followers >= CFG.followerCut) ? panels.contas : panels.pessoas;
        if (acc.el.parentElement !== target) target.appendChild(acc.el);
    }

    scheduleTabCounts();
}

// Com 10 lanes respondendo juntas, mexer no DOM a cada resposta trava a rolagem.
// Agrupa as atualizacoes de contador num unico frame.
let countsQueued = false;
function scheduleTabCounts() {
    if (countsQueued) return;
    countsQueued = true;
    requestAnimationFrame(function () {
        countsQueued = false;
        refreshTabCounts();
    });
}

/* -------------------- cartão de preview (hover) -------------------- */

const preview = document.createElement('div');
preview.className = 'preview';
preview.hidden = true;
modal.appendChild(preview);

let previewFor = null;
let previewTouch = false;
let previewShowTimer = null;
let previewHideTimer = null;
let previewToken = 0;

function previewStats(profile) {
    return '<div class="preview-stats">' +
        '<div><b>' + shortNumber(profile.m) + '</b><span>publicações</span></div>' +
        '<div><b>' + shortNumber(profile.c) + '</b><span>seguidores</span></div>' +
        '<div><b>' + shortNumber(profile.f) + '</b><span>seguindo</span></div>' +
    '</div>';
}

function paintPreview(acc, profile) {
    const bucket = profile ? (profile.c >= CFG.followerCut ? 'Conta' : 'Pessoa') : null;

    preview.innerHTML =
        '<div class="preview-head">' +
            '<img src="' + escapeHtml(acc.pic || '') + '">' +
            '<div class="preview-id">' +
                '<div class="preview-user">@' + escapeHtml(acc.username) +
                    (profile && profile.v ? '<span class="preview-check" title="Verificado">✓</span>' : '') +
                '</div>' +
                (acc.fullName ? '<div class="preview-name">' + escapeHtml(acc.fullName) + '</div>' : '') +
                (bucket ? '<div class="preview-tag">' + bucket + '</div>' : '') +
            '</div>' +
        '</div>' +
        (profile
            ? previewStats(profile) +
              (profile.p ? '<div class="preview-lock">Conta privada</div>' : '') +
              (profile.b ? '<div class="preview-bio">' + escapeHtml(profile.b) + '</div>' : '')
            : '<div class="preview-loading">carregando perfil…</div>');
}

/* -------------------- Scroll das Contas ---------------------------- */

/* Toda API de mídia deu erro nesta conta (clips/user 400, web_profile_info
 * 429, feed/user 404 e HTML). Então aqui não se pede mídia para ninguém: o
 * navegador simplesmente ABRE a página /usuario/reels/ numa aba, que é uma
 * navegação comum e não entra na cota de API. Uma aba só, reaproveitada a
 * cada perfil. Quem captura as teclas lá é o reelsControls.js. */

/* ----------------- registro do que já foi revisado ----------------- */

/* Antes o progresso do Scroll morria ao fechar o modal: toda sessao
 * recomecava da primeira conta. Agora cada decisao fica gravada, e o
 * filtro abaixo deixa voltar so no que falta -- ou reler o que ja passou. */

const REVIEW_KEY = 'nao-seguidores:revisados';

// quanto tempo a decisao do Scroll e lembrada (filtro "Nao revisados")
const REVIEW_TTL = 30 * 24 * 60 * 60 * 1000;

let reviewed = {};
try { reviewed = JSON.parse(localStorage.getItem(REVIEW_KEY) || '{}') || {}; } catch (e) { reviewed = {}; }

// varre os expirados uma vez, na abertura
(function pruneReviewed() {
    const now = Date.now();
    let mexeu = false;
    Object.keys(reviewed).forEach(function (id) {
        const e = reviewed[id];
        if (!e || !e.at || now - e.at > REVIEW_TTL) { delete reviewed[id]; mexeu = true; }
    });
    if (mexeu) saveReviewed();
})();

function saveReviewed() {
    try { localStorage.setItem(REVIEW_KEY, JSON.stringify(reviewed)); } catch (e) {}
}

function isReviewed(id) { return !!reviewed[id]; }

/* Guarda so o essencial: quem, quando e qual foi a decisao. Isso alimenta o
 * filtro "Nao revisados" do Scroll e a marca de visto nas listas. */
function markReviewed(acc, action) {
    if (!acc) return;
    reviewed[acc.id] = { at: Date.now(), action: action, u: acc.username };
    saveReviewed();
    paintReviewMark(acc);
}

function paintReviewMark(acc) {
    if (!acc || !acc.el) return;
    const entry = reviewed[acc.id];
    acc.el.classList.toggle('is-reviewed', !!entry);
    const mark = acc.el.querySelector('.seen');
    if (mark && entry) {
        mark.title = entry.action === 'unfollowed'
            ? 'Revisado — você deixou de seguir'
            : 'Revisado — você manteve seguindo';
    }
}

function clearReviewed() {
    reviewed = {};
    saveReviewed();
    Array.prototype.forEach.call(panels.contas.children, function (row) {
        row.classList.remove('is-reviewed');
    });
    Array.prototype.forEach.call(panels.pessoas.children, function (row) {
        row.classList.remove('is-reviewed');
    });
}

const scroller = {
    open: false,
    list: [],
    index: 0,
    busy: false,
    viewerOpen: false,
    filter: 'pendentes'        // pendentes | revisados | todos
};

function scrollerMarkup() {
    return '' +
    '<div class="sc-panel">' +
        '<div class="sc-filter">' +
            '<button class="sc-f" data-filter="pendentes">Não revisados <b>0</b></button>' +
            '<button class="sc-f" data-filter="revisados">Revisados <b>0</b></button>' +
            '<button class="sc-f" data-filter="todos">Todos <b>0</b></button>' +
        '</div>' +
        '<div class="sc-card">' +
            '<img class="sc-pic" alt="">' +
            '<div class="sc-who">' +
                '<div class="sc-user">—</div>' +
                '<div class="sc-meta"></div>' +
            '</div>' +
        '</div>' +
        '<div class="sc-state"></div>' +
        '<div class="sc-keys">' +
            '<button class="sc-key" data-act="another"><b>←</b> ou <b>A</b><span>outro vídeo</span></button>' +
            '<button class="sc-key" data-act="next"><b>↓</b> ou <b>S</b><span>manter e avançar</span></button>' +
            '<button class="sc-key sc-danger" data-act="unfollow"><b>→</b> ou <b>D</b><span>deixar de seguir</span></button>' +
        '</div>' +
        '<div class="sc-foot">Os vídeos abrem numa aba ao lado. As teclas funcionam lá também.' +
            '<button class="sc-reset">limpar revisados</button></div>' +
    '</div>';
}

function scrollerEl(sel) { return panels.scroll.querySelector(sel); }

function scrollerState(text, kind) {
    const box = scrollerEl('.sc-state');
    if (box) box.innerHTML = text ? '<span class="' + (kind || '') + '">' + text + '</span>' : '';
}

function bg(message) {
    return new Promise(function (resolve) {
        try {
            chrome.runtime.sendMessage(message, function (res) {
                void chrome.runtime.lastError;      // silencia "no receiving end"
                resolve(res || null);
            });
        } catch (e) { resolve(null); }
    });
}

// só contas: a aba existe justamente para triar perfis grandes
function allContas() {
    return Array.prototype.map.call(
        panels.contas.children,
        function (row) { return rowsById.get(row.dataset.id); }
    ).filter(Boolean);
}

function buildScrollList() {
    const todas = allContas();
    const pendentes = todas.filter(function (a) { return !isReviewed(a.id); });
    const revisadas = todas.filter(function (a) { return isReviewed(a.id); });

    const counts = { pendentes: pendentes.length, revisados: revisadas.length, todos: todas.length };
    panels.scroll.querySelectorAll('.sc-f').forEach(function (b) {
        b.querySelector('b').innerText = counts[b.dataset.filter];
        b.classList.toggle('active', b.dataset.filter === scroller.filter);
    });

    scroller.list = scroller.filter === 'revisados' ? revisadas
                  : scroller.filter === 'todos' ? todas
                  : pendentes;
    scroller.index = 0;
}

function openScroller() {
    if (!panels.scroll.firstChild) panels.scroll.innerHTML = scrollerMarkup();

    scroller.open = true;

    if (!allContas().length) {
        scroller.list = [];
        scrollerState('Nenhuma conta com ' + CFG.followerCut.toLocaleString('pt-BR') +
                      '+ seguidores na lista. Carregue primeiro.', 'warn');
        return;
    }

    buildScrollList();

    if (!scroller.list.length) {
        scrollerState(scroller.filter === 'pendentes'
            ? 'Você já revisou todas as contas. Troque o filtro para rever alguma.'
            : 'Nenhuma conta neste filtro.', 'done');
        return;
    }

    bg({ type: 'ns:register' });
    showCurrent();
}

function setScrollFilter(name) {
    if (scroller.filter === name) return;
    scroller.filter = name;
    bg({ type: 'ns:close-viewer' });
    scroller.viewerOpen = false;
    openScroller();
}

function closeScroller() {
    if (!scroller.open) return;
    scroller.open = false;
    scroller.viewerOpen = false;
    bg({ type: 'ns:close-viewer' });
}

function currentAccount() { return scroller.list[scroller.index] || null; }

async function showCurrent() {
    const acc = currentAccount();
    if (!acc || !scroller.open) return;

    scrollerEl('.sc-pic').src = acc.pic || '';
    scrollerEl('.sc-user').innerText = '@' + acc.username;
    scrollerEl('.sc-meta').innerText =
        (acc.followers ? shortNumber(acc.followers) + ' seguidores · ' : '') +
        (scroller.index + 1) + ' de ' + scroller.list.length;

    scrollerState('abrindo os reels de @' + acc.username + '…');

    const res = await bg({
        type: 'ns:open-viewer',
        info: {
            username: acc.username,
            position: (scroller.index + 1) + ' de ' + scroller.list.length
        }
    });

    if (!scroller.open) return;

    if (res && res.ok) {
        scroller.viewerOpen = true;
        scrollerState('');
    } else {
        scrollerState('não foi possível abrir a aba de visualização', 'warn');
    }
}

function scrollerNext(markAs) {
    if (!scroller.open || scroller.busy) return;

    if (markAs) markReviewed(currentAccount(), markAs);

    scroller.index++;
    if (scroller.index >= scroller.list.length) {
        scroller.index = scroller.list.length;
        bg({ type: 'ns:close-viewer' });
        bg({ type: 'ns:focus-controller' });
        scroller.viewerOpen = false;
        scrollerEl('.sc-user').innerText = '—';
        scrollerEl('.sc-meta').innerText = '';
        scrollerEl('.sc-pic').removeAttribute('src');
        scrollerState('Fim da lista — ' + scroller.list.length + ' contas nesta rodada. ' +
                      'Total já revisado: ' + Object.keys(reviewed).length + '.', 'done');
        buildScrollList();     // atualiza os contadores do filtro
        scroller.list = [];    // e zera a fila: tecla apertada agora não age em ninguém
        return;
    }

    showCurrent();
}

// mesma conta, outro sorteio: o background recarrega a página de reels
function scrollerAnother() {
    if (!scroller.open || scroller.busy) return;
    if (!currentAccount()) return;
    showCurrent();
}

async function scrollerUnfollow() {
    const acc = currentAccount();
    if (!acc || scroller.busy || !scroller.open) return;

    scroller.busy = true;
    scrollerState('deixando de seguir @' + acc.username + '…');

    const button = acc.el && acc.el.querySelector('.unfollow');
    if (button && !button.disabled) {
        button.disabled = true;
        try { await doUnfollow(button); } catch (e) {}
    }

    scroller.busy = false;
    if (scroller.open) scrollerNext('unfollowed');
}

function scrollerDo(action) {
    if (action === 'next') scrollerNext('kept');
    else if (action === 'unfollow') scrollerUnfollow();
    else if (action === 'another') scrollerAnother();
}

// teclas apertadas na aba de visualização chegam por aqui
try {
    chrome.runtime.onMessage.addListener(function (msg) {
        if (!msg || !scroller.open) return;
        if (msg.type === 'ns:action') scrollerDo(msg.action);
        else if (msg.type === 'ns:viewer-closed') {
            scroller.viewerOpen = false;
            scrollerState('A aba de visualização foi fechada. Use os botões para continuar.', 'warn');
        }
    });
} catch (e) {}

// e também funcionam no próprio modal
document.addEventListener('keydown', function (ev) {
    if (!scroller.open || panels.scroll.hidden) return;
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return;

    const tag = ev.target && ev.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    const k = (ev.key || '').toLowerCase();
    let action = null;

    if (k === 'arrowdown' || k === 's') action = 'next';
    else if (k === 'arrowright' || k === 'd') action = 'unfollow';
    else if (k === 'arrowleft' || k === 'a') action = 'another';
    else return;

    ev.preventDefault();
    scrollerDo(action);
});

panels.scroll.addEventListener('click', function (ev) {
    const filtro = ev.target.closest('.sc-f');
    if (filtro) { setScrollFilter(filtro.dataset.filter); return; }

    if (ev.target.closest('.sc-reset')) {
        if (!confirm('Esquecer todas as contas já revisadas?')) return;
        clearReviewed();
        openScroller();
        return;
    }

    const btn = ev.target.closest('.sc-key');
    if (btn) scrollerDo(btn.dataset.act);
});

function placePreview(row) {
    const r = row.getBoundingClientRect();
    preview.hidden = false;

    const w = preview.offsetWidth;
    const h = preview.offsetHeight;
    const margin = 10;
    let left, top;

    if (previewTouch) {
        // No toque o cartao ao lado nao serve: a mao cobre a lista inteira.
        // Centraliza e joga para cima da linha; se nao couber, para baixo.
        left = (window.innerWidth - w) / 2;
        top = r.top - h - 14;
        if (top < margin) top = r.bottom + 14;
    } else {
        // prefere a direita da linha; se nao couber, vai para a esquerda
        left = r.right + margin;
        if (left + w > window.innerWidth - margin) left = r.left - w - margin;
        top = r.top + r.height / 2 - h / 2;
    }

    left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - h - margin));

    preview.style.left = left + 'px';
    preview.style.top = top + 'px';
}

async function showPreview(row, touchMode) {
    const acc = rowsById.get(row.dataset.id);
    if (!acc) return;

    previewFor = row;
    previewTouch = !!touchMode;
    const token = ++previewToken;

    paintPreview(acc, acc.profile);
    placePreview(row);

    if (acc.profile) return;

    // ainda nao classificado: busca na hora, furando a fila da separacao
    try {
        const profile = await fetchProfile(acc.id, true);
        if (token !== previewToken) return;         // o mouse ja saiu
        cacheSet(acc.id, profile);
        classify(acc, profile);
        paintPreview(acc, profile);
        placePreview(row);
    } catch (e) {
        if (token !== previewToken) return;
        const box = preview.querySelector('.preview-loading');
        if (box) box.innerText = 'não foi possível carregar este perfil';
    }
}

function hidePreview() {
    previewFor = null;
    previewToken++;
    preview.hidden = true;
}

modal.addEventListener('mouseover', function (ev) {
    if (ev.target.closest('.preview')) {         // mouse entrou no proprio cartao
        clearTimeout(previewHideTimer);
        return;
    }

    const row = ev.target.closest('.row');
    if (!row || !row.dataset.id) return;

    clearTimeout(previewHideTimer);
    if (previewFor === row) return;

    clearTimeout(previewShowTimer);
    previewShowTimer = setTimeout(function () { showPreview(row); }, 320);
});

modal.addEventListener('mouseout', function (ev) {
    if (!ev.target.closest('.row') && !ev.target.closest('.preview')) return;
    clearTimeout(previewShowTimer);
    clearTimeout(previewHideTimer);
    previewHideTimer = setTimeout(hidePreview, 200);
});

// rolar a lista invalida a posicao do cartao
document.querySelector('.modal-body').addEventListener('scroll', function () {
    if (previewFor) hidePreview();
}, { passive: true });

/* ------------- gesto de toque: segurar e arrastar ------------------ */

/* Toque nao tem hover. O equivalente natural e segurar o dedo sobre um
 * perfil e arrastar pela lista: o cartao acompanha quem estiver sob o dedo.
 * O truque e distinguir "segurar para espiar" de "arrastar para rolar",
 * e isso se resolve no tempo: se o dedo andar antes de ~280ms, e rolagem. */

const scrubBody = document.querySelector('.modal-body');

const scrub = {
    pointerId: null,
    timer: null,
    active: false,
    row: null,
    x: 0,
    y: 0
};

let suppressClick = false;

function startScrub(row) {
    scrub.active = true;
    scrub.row = row;
    preview.classList.add('through');     // o cartao nao pode roubar o elementFromPoint
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) {} }
    showPreview(row, true);
}

function endScrub() {
    clearTimeout(scrub.timer);
    scrub.timer = null;

    if (scrub.active) {
        scrub.active = false;
        preview.classList.remove('through');
        hidePreview();
        // o dedo levantando gera um click sintetico no link do perfil
        suppressClick = true;
        setTimeout(function () { suppressClick = false; }, 400);
    }

    scrub.pointerId = null;
    scrub.row = null;
}

scrubBody.addEventListener('pointerdown', function (ev) {
    if (ev.pointerType === 'mouse') return;        // mouse ja tem hover
    const row = ev.target.closest('.row');
    if (!row || !row.dataset.id) return;

    scrub.pointerId = ev.pointerId;
    scrub.x = ev.clientX;
    scrub.y = ev.clientY;
    scrub.row = row;

    clearTimeout(scrub.timer);
    scrub.timer = setTimeout(function () { startScrub(row); }, 280);
});

scrubBody.addEventListener('pointermove', function (ev) {
    if (ev.pointerId !== scrub.pointerId) return;

    if (!scrub.active) {
        // andou antes de completar a espera: era rolagem, desiste
        if (Math.abs(ev.clientY - scrub.y) > 10 || Math.abs(ev.clientX - scrub.x) > 10) {
            clearTimeout(scrub.timer);
            scrub.timer = null;
            scrub.pointerId = null;
        }
        return;
    }

    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const row = el && el.closest ? el.closest('.row') : null;
    if (row && row !== scrub.row && row.dataset.id) {
        scrub.row = row;
        showPreview(row, true);
    }
});

scrubBody.addEventListener('pointerup', endScrub);
scrubBody.addEventListener('pointercancel', endScrub);

// seguro contra gesto travado: se o dedo soltar fora da lista, encerra igual
document.addEventListener('pointerup', endScrub);
document.addEventListener('pointercancel', endScrub);

// Enquanto o gesto esta ativo a lista nao pode rolar. Mudar touch-action no
// meio do gesto nao surte efeito, entao o jeito confiavel e barrar o
// touchmove -- e para isso o listener precisa ser passive: false.
scrubBody.addEventListener('touchmove', function (ev) {
    if (scrub.active) ev.preventDefault();
}, { passive: false });

// segurar o dedo sobre um link abre o menu do navegador; aqui nao
modal.addEventListener('contextmenu', function (ev) {
    if (scrub.active || scrub.timer) ev.preventDefault();
});

/* ------------- classificação por número de seguidores -------------- */

/* Leitura de perfil e varredura tem riscos diferentes, entao tem ritmos
 * diferentes. A varredura usa pace(): lento, serializado, com micro-pausas.
 * Aqui sao GETs de perfil publico, o mesmo que o navegador faz quando voce
 * rola o Instagram, entao pode ir muito mais rapido -- desde que freie na
 * hora em que o Instagram reclamar. Dai o freio adaptativo abaixo. */
const reader = {
    gap: CFG.enrichGap,
    gapMin: CFG.enrichGapMin,
    gapMax: 10000,
    chain: Promise.resolve(),
    wins: 0
};

// mesma ideia do pace(): a espera e serializada, entao N lanes em paralelo
// sobrepoem a latencia da rede sem multiplicar a taxa de requisicoes
function readerSlot() {
    const step = reader.chain.then(function () {
        return sleep(Math.round(reader.gap * (0.7 + Math.random() * 0.6)));
    });
    reader.chain = step.catch(function () {});
    return step;
}

function readerBrake() {
    reader.wins = 0;
    reader.gap = Math.min(reader.gapMax, Math.round(reader.gap * 3));
    console.warn('[Não Seguidores] freando: intervalo agora ' + reader.gap + 'ms');
}

// acelera enquanto o Instagram deixa, ate o piso configurado
function readerEase() {
    if (++reader.wins < 12) return;
    reader.wins = 0;
    if (reader.gap <= reader.gapMin) return;
    reader.gap = Math.max(reader.gapMin, Math.round(reader.gap * 0.82));
}

async function fetchProfile(id, immediate) {
    if (!immediate) await readerSlot();

    const res = await fetch('https://www.instagram.com/api/v1/users/' + id + '/info/', {
        headers: headersGet,
        credentials: 'include',
        mode: 'cors'
    });

    absorbClaim(res);

    if (res.status === 429 || res.status >= 500) {
        const e = fail('O Instagram limitou as consultas.');
        e.rateLimited = true;
        throw e;
    }
    if (res.status === 401 || res.status === 403) {
        throw fail('O Instagram recusou a consulta. Faça login novamente.', true);
    }
    if (!res.ok) throw fail('status ' + res.status);

    const data = JSON.parse(await res.text());

    const guard = guardMessage(data);
    if (guard) throw fail(guard, true);

    const u = data.user || {};
    return {
        t: Date.now(),
        c: u.follower_count || 0,
        f: u.following_count || 0,
        m: u.media_count || 0,
        b: (u.biography || '').slice(0, 200),
        v: !!u.is_verified,
        p: !!u.is_private
    };
}

function formatEta(seconds) {
    if (seconds < 60) return seconds + 's';
    return Math.floor(seconds / 60) + 'min' + (seconds % 60 ? ' ' + (seconds % 60) + 's' : '');
}

async function enrich(accounts) {
    // 1) cache primeiro: quem ja foi consultado e ainda esta valido sai de graca
    const pending = [];
    accounts.forEach(function (acc) {
        const cached = cacheGet(acc.id);
        if (cached) classify(acc, cached);
        else pending.push(acc);
    });

    const fromCache = accounts.length - pending.length;
    if (fromCache) {
        console.info('[Não Seguidores] ' + fromCache + ' de ' + accounts.length + ' vieram do cache');
    }

    if (!pending.length || !running) {
        cacheFlush();
        refreshTabCounts();
        if (fromCache) note('', 'Separação instantânea: ' + fromCache + ' perfis vieram do cache.');
        return;
    }

    const total = pending.length;
    const queue = pending.slice();
    const started = Date.now();
    let done = 0;
    let deadInARow = 0;
    let stopped = false;
    let lastPaint = 0;

    function tick(force) {
        const now = Date.now();
        if (!force && now - lastPaint < 180) return;   // nao repinta a cada resposta
        lastPaint = now;

        const elapsed = (now - started) / 1000;
        const rate = elapsed > 1 ? done / elapsed : 0;
        const eta = rate > 0 ? Math.ceil((total - done) / rate) : 0;
        note('', 'Separando Pessoas e Contas: ' + done + '/' + total +
                 (fromCache ? ' (' + fromCache + ' do cache)' : '') +
                 (eta > 2 ? ' — faltam ~' + formatEta(eta) : ''));
    }
    tick(true);

    async function lane() {
        while (!stopped && running && queue.length) {
            const acc = queue.shift();

            try {
                const profile = await fetchProfile(acc.id);
                cacheSet(acc.id, profile);
                classify(acc, profile);
                readerEase();
                deadInARow = 0;
            } catch (e) {
                if (e && e.fatal) { stopped = true; throw e; }

                if (e && e.rateLimited) {
                    readerBrake();
                    acc.tries = (acc.tries || 0) + 1;
                    if (acc.tries < 3) {
                        queue.push(acc);          // volta para o fim da fila
                        await sleep(2000 + Math.random() * 3000);
                        continue;                 // nao conta como concluido
                    }
                }

                classify(acc, null);              // fica em Pessoas com "—"
                if (++deadInARow >= 20) {
                    stopped = true;
                    throw fail('Muitas consultas seguidas falharam. A separação foi interrompida; ' +
                               'os perfis sem número ficaram na aba Pessoas.');
                }
            }

            done++;
            tick(false);
            if (done % 40 === 0) cacheFlush();     // nao perde tudo se fechar a aba
        }
    }

    let laneError = null;
    const lanes = [];
    for (let i = 0; i < CFG.enrichLanes; i++) {
        lanes.push(lane().catch(function (e) { laneError = laneError || e; }));
    }
    await Promise.all(lanes);

    cacheFlush();
    refreshTabCounts();

    const secs = Math.round((Date.now() - started) / 1000);
    console.info('[Não Seguidores] separação: ' + done + '/' + total + ' em ' + secs +
                 's (' + (done / Math.max(secs, 1)).toFixed(1) + '/s, intervalo final ' + reader.gap + 'ms)');

    if (laneError && laneError.userMessage) note('warning', laneError.userMessage);
    else if (running) note('', '');
}

/* --------------------------- varredura ---------------------------- */

// caminho rápido: lista "seguindo" + show_many em lotes de 100
async function fastScan(onFound) {
    const buffer = [];
    let processed = 0;
    let supported = true;
    let inlineLogged = false;

    async function flush(force) {
        while (running && (buffer.length >= CFG.statusBatch || (force && buffer.length))) {
            const batch = buffer.splice(0, CFG.statusBatch);

            // caminho ideal: a listagem ja trouxe followed_by, custo zero
            if (batch.every(function (a) { return a.followsBack !== null; })) {
                if (!inlineLogged) {
                    inlineLogged = true;
                    console.info('[Não Seguidores] friendship_status veio na própria listagem, sem consultas extras');
                }
                await onFound(batch.filter(function (a) { return !a.followsBack; }));
                continue;
            }

            if (!supported) {
                // show_many ja falhou: devolve o lote para o método antigo
                buffer.unshift.apply(buffer, batch);
                return;
            }

            let missing;
            try {
                missing = await askFollowsBack(batch);
            } catch (e) {
                // só cai para o método antigo se o endpoint em si não existir mais;
                // limite de requisições é problema de ritmo, não de método
                if (!e || !e.unsupported) throw e;
                supported = false;
                buffer.unshift.apply(buffer, batch);
                console.warn('[Não Seguidores] show_many indisponível, usando o método antigo');
                return;
            }
            if (missing === null) return;
            await onFound(missing);
        }
    }

    const all = await walkList('following', async function (page) {
        processed += page.length;
        setProgress(processed / (selfFollowing || 1));
        page.forEach(function (a) { buffer.push(a); });
        await flush(false);
    });

    if (supported && running) await flush(true);

    return { supported: supported, all: all.rows };
}

// caminho antigo: baixa a lista completa de seguidores e compara
async function legacyScan(following, onFound) {
    if (selfFollowers > CFG.legacyFollowerCap) {
        throw fail('O método rápido não está disponível agora e sua conta tem ' +
            selfFollowers.toLocaleString('pt-BR') + ' seguidores, acima do limite de ' +
            CFG.legacyFollowerCap.toLocaleString('pt-BR') + ' do método alternativo. Tente novamente mais tarde.');
    }

    note('warning', 'Método rápido indisponível. Usando o método alternativo (mais lento)...');

    let seen = 0;
    const followers = await walkList('followers', function (page) {
        seen += page.length;
        setProgress(seen / (selfFollowers || 1));
    });
    if (!running) return;

    lastScan.followerIds = followers.ids;      // a aba Amigos reusa isso
    await onFound(following.filter(function (a) { return !followers.ids.has(a.id); }));
    note('', '');
}

/* -------------------------- Amigos -------------------------------- */

/* Amigos = quem voce segue E que te segue de volta. Sai da mesma varredura:
 * o metodo antigo ja baixa as duas listas, entao e so a intersecao. Mas nao
 * renderizamos junto -- podem ser milhares de linhas, e a maioria das vezes
 * o usuario abriu a extensao para ver quem NAO segue. Por isso so calcula
 * quando o botao e apertado. */

let lastScan = { following: [], followerIds: null };

function friendsSay(text, kind) {
    friendsNote.innerHTML = text ? '<span class="' + (kind || '') + '">' + text + '</span>' : '';
}

// desenha em lotes: 900 linhas de uma vez travam a aba
function renderInChunks(list, done) {
    let i = 0;

    (function step() {
        const until = Math.min(i + 80, list.length);
        for (; i < until; i++) {
            const acc = list[i];
            renderRow(acc, friendsList);
            const cached = cacheGet(acc.id);
            if (cached) classify(acc, cached);   // usa só o que já está em cache
        }

        refreshTabCounts();

        if (i < list.length) {
            friendsSay(i + ' de ' + list.length + '…');
            requestAnimationFrame(step);
        } else if (done) done();
    })();
}

async function showFriends() {
    if (!lastScan.following.length) {
        friendsSay('Carregue a lista primeiro na aba Pessoas.', 'warn');
        return;
    }

    friendsBtn.disabled = true;
    friendsList.innerHTML = '';

    try {
        if (!lastScan.followerIds) {
            // caminho rapido foi usado: a lista de seguidores nao foi baixada
            running = true;
            friendsSay('Baixando sua lista de seguidores…');
            const followers = await walkList('followers');
            running = false;
            if (!followers) { friendsSay('Não foi possível carregar.', 'warn'); return; }
            lastScan.followerIds = followers.ids;
        }

        const friends = lastScan.following.filter(function (a) {
            return lastScan.followerIds.has(a.id);
        });

        if (!friends.length) {
            friendsSay('Nenhum amigo encontrado.', 'warn');
            return;
        }

        renderInChunks(friends, function () {
            friendsSay(friends.length + ' amigos — de ' + lastScan.following.length + ' perfis que você segue.');
        });
    } catch (e) {
        running = false;
        friendsSay(e && e.userMessage ? e.userMessage : 'Não foi possível calcular os amigos.', 'warn');
    } finally {
        friendsBtn.disabled = false;
    }
}

friendsBtn.addEventListener('click', showFriends);

async function run() {
    progress = 0;
    playBtn.disabled = true;
    playBtn.innerText = 'Carregando (0%)';
    note('', '');
    panels.pessoas.innerHTML = '';
    panels.contas.innerHTML = '';
    friendsList.innerHTML = '';
    friendsSay('');
    lastScan = { following: [], followerIds: null };
    rowsById.clear();
    hidePreview();
    refreshTabCounts();
    running = true;

    const found = [];

    async function onFound(list) {
        if (!list || !list.length) return;
        list.forEach(function (acc) {
            found.push(acc);
            renderRow(acc);
        });
        revealTabs();
        refreshTabCounts();
    }

    try {
        const result = await fastScan(onFound);
        if (!running) return;

        lastScan.following = result.all || [];

        if (!result.supported) {
            // show_many recusou no meio do caminho: refaz pelo método antigo
            panels.pessoas.innerHTML = '';
            panels.contas.innerHTML = '';
            found.length = 0;
            progress = 0;
            refreshTabCounts();
            await legacyScan(result.all, onFound);
            if (!running) return;
        }

        if (!found.length) {
            note('warning', 'Nenhum registro encontrado.');
            running = false;
            resetButton();
            return;
        }

        playBtn.innerText = 'Separando...';
        await enrich(found);
        running = false;
        resetButton('Recarregar');
    } catch (e) {
        running = false;
        resetButton();
        if (e && e.userMessage) {
            note('danger', e.userMessage);
            alert(e.userMessage);
            return;
        }
        note('danger', 'Não foi possível consultar os não seguidores (' + e + ')');
    }
}

/* ---------------------------- unfollow ---------------------------- */

// Sem trava rígida: os cliques entram numa fila e saem com espaçamento
// aleatório, que é o que de fato evita a marcação como automação.
// Mesma historia do show_many: a rota de unfollow nao esta no mesmo lugar em
// todos os hosts. A primeira e a que a versao 1.4.3 usava e funcionava.
const UNFOLLOW_URLS = [
    function (id) { return 'https://i.instagram.com/api/v1/web/friendships/' + id + '/unfollow/'; },
    function (id) { return 'https://www.instagram.com/web/friendships/' + id + '/unfollow/'; },
    function (id) { return 'https://www.instagram.com/api/v1/friendships/unfollow/' + id + '/'; }
];

let unfollowUrl = null;
let unfollowChain = Promise.resolve();
let unfollowBlocked = false;

function queueUnfollow(button) {
    if (button.disabled || unfollowBlocked) return;
    button.disabled = true;
    button.innerHTML = '<span class="loading" style="width:16px;height:16px;display:inline-block;vertical-align:middle">' + SPINNER + '</span>';

    unfollowChain = unfollowChain
        .then(function () { return doUnfollow(button); })
        .catch(function () {});
}

function releaseButton(button) {
    button.disabled = false;
    button.innerText = 'Seguindo';
}

async function doUnfollow(button) {
    if (unfollowBlocked) { releaseButton(button); return; }

    await sleep(CFG.unfollowGapMin + Math.random() * (CFG.unfollowGapMax - CFG.unfollowGapMin));

    const id = button.getAttribute('data-id');
    const candidates = unfollowUrl ? [unfollowUrl] : UNFOLLOW_URLS;
    let data = null;
    let rateLimited = false;
    let networkError = false;

    for (let i = 0; i < candidates.length; i++) {
        const build = candidates[i];
        let res;

        try {
            res = await fetch(build(id), {
                method: 'POST',
                headers: headersPost,
                credentials: 'include',
                mode: 'cors'
            });
        } catch (e) {
            networkError = true;
            console.warn('[Não Seguidores] unfollow falhou em ' + build(id) + ': ' + e.message);
            continue;
        }

        absorbClaim(res);

        if (res.status === 429) { rateLimited = true; break; }

        if (!res.ok) {
            console.warn('[Não Seguidores] unfollow status ' + res.status + ' em ' + build(id));
            continue;
        }

        // status 200 com HTML = rota inexistente nesse host, tenta a próxima
        let parsed = null;
        try { parsed = JSON.parse(await res.text()); } catch (e) {
            console.warn('[Não Seguidores] unfollow devolveu não-JSON em ' + build(id));
            continue;
        }

        data = parsed;
        if (!unfollowUrl) {
            unfollowUrl = build;
            console.info('[Não Seguidores] unfollow ativo em ' + build(id));
        }
        break;
    }

    if (rateLimited) {
        releaseButton(button);
        alert('O Instagram limitou as ações por excesso de requisições. Espere alguns minutos antes de continuar.');
        return;
    }

    const guard = guardMessage(data);
    if (guard) {
        unfollowBlocked = true;
        releaseButton(button);
        note('danger', guard);
        alert(guard);
        return;
    }

    if (!data || data.status !== 'ok') {
        releaseButton(button);
        alert('Parece que o Instagram está bloqueando a requisição (' +
            (networkError ? 'ERRO-03' : 'ERRO-02') + '). Detalhes no Console (F12).');
        return;
    }

    button.innerText = 'Removido';
    button.classList.add('unfollow-success');
    unfollowCount++;

    if (unfollowCount % CFG.unfollowAlertAt === 0) {
        alert('Você já deixou de seguir ' + unfollowCount + ' perfis nesta sessão.\n\n' +
              'O Instagram costuma marcar como automação quem faz muitos unfollows seguidos. ' +
              'Dar uma pausa agora reduz bastante o risco de bloqueio.\n\n' +
              'Isto é apenas um aviso: você pode continuar se quiser.');
    }
}

/* --------------------------- Stories ------------------------------- */

/* Duas fontes para a bandeja, nessa ordem:
 *
 *   1) feed/reels_tray/ -- devolve tudo com o carimbo "seen" de cada conta.
 *      Dado limpo, mas e da familia /api/v1/feed/, que ja morreu nas outras
 *      tentativas. Por isso nao dependemos dela.
 *
 *   2) o DOM da propria pagina. A barra esta atras do modal, ja renderizada.
 *      Custo zero. O estado visto/nao visto o Instagram desenha no anel:
 *      colorido = nao visto, cinza = visto. Como o anel e um <canvas>, lemos
 *      os pixels e medimos a saturacao -- cinza da zero, o degrade nao.
 *
 * A divisao Pessoas/Contas sai do MESMO numero de seguidores do resto da
 * extensao, e quase sempre de graca: a varredura ja deixou essas contas em
 * cache. So o que faltar vira consulta. */

const TRAY_MEMO = 'nao-seguidores:tray';
let trayDead = false;
try { trayDead = localStorage.getItem(TRAY_MEMO) === 'dead'; } catch (e) {}

const storiesList = panels.stories.querySelector('.st-list');
const storiesNote = panels.stories.querySelector('.st-note');

let storiesData = [];
let storiesGroup = 'pessoas';      // pessoas | contas
let storiesState = 'novos';        // novos | vistos

function storiesSay(text, kind) {
    storiesNote.innerHTML = text ? '<span class="' + (kind || '') + '">' + text + '</span>' : '';
}

/* ---------------------- fonte 1: a API ----------------------------- */

function marcaTrayMorta() {
    trayDead = true;
    try { localStorage.setItem(TRAY_MEMO, 'dead'); } catch (e) {}
    console.warn('[Não Seguidores] reels_tray indisponível; lendo a barra pelo DOM');
}

async function trayFromApi() {
    if (trayDead) return null;

    await readerSlot();

    try {
        const res = await fetch('https://www.instagram.com/api/v1/feed/reels_tray/', {
            headers: headersGet, credentials: 'include', mode: 'cors'
        });

        absorbClaim(res);

        if (res.status === 429) { readerBrake(); return null; }
        if (res.status === 404 || res.status === 400) { marcaTrayMorta(); return null; }
        if (!res.ok) return null;

        const text = await res.text();
        if (/^\s*</.test(text)) { marcaTrayMorta(); return null; }

        const data = JSON.parse(text);
        const tray = data.tray || data.items || [];
        if (!tray.length) return null;

        return tray.map(function (item) {
            const u = item.user || {};
            const seen = item.seen || 0;
            const latest = item.latest_reel_media || 0;
            return {
                id: String(u.pk || u.pk_id || ''),
                username: u.username || '',
                fullName: u.full_name || '',
                pic: u.profile_pic_url || '',
                novo: !seen || seen < latest
            };
        }).filter(function (x) { return x.username; });
    } catch (e) {
        return null;
    }
}

/* ---------------------- fonte 2: o DOM ----------------------------- */

// anel colorido = story novo. Le uma linha de pixels do canvas do anel e
// pega a maior saturacao; cinza fica em zero, o degrade do IG passa de 0,8.
function anelColorido(canvas) {
    try {
        const ctx = canvas.getContext('2d');
        if (!ctx || !canvas.width || !canvas.height) return null;

        const linha = ctx.getImageData(0, Math.floor(canvas.height / 2), canvas.width, 1).data;
        let maior = 0;

        for (let i = 0; i < linha.length; i += 4) {
            if (linha[i + 3] < 40) continue;             // transparente, ignora
            const r = linha[i], g = linha[i + 1], b = linha[i + 2];
            const mx = Math.max(r, g, b);
            if (!mx) continue;
            const sat = (mx - Math.min(r, g, b)) / mx;
            if (sat > maior) maior = sat;
        }

        return maior > 0.35;
    } catch (e) {
        return null;      // canvas contaminado ou sem contexto 2d
    }
}

// o texto sob o avatar vem truncado ("mollys_mi..."); o alt da imagem traz
// o nome inteiro, em qualquer idioma que o Instagram esteja usando
function usuarioDoAlt(alt) {
    if (!alt) return '';
    const m = alt.match(/(?:de|of)\s+([A-Za-z0-9._]+)/i)
           || alt.match(/^([A-Za-z0-9._]+)['’]s/)
           || alt.match(/^([A-Za-z0-9._]+)$/);
    return m ? m[1] : '';
}

function trayFromDom() {
    const canvases = document.querySelectorAll('main canvas, section canvas, header canvas');
    const achados = [];
    const jaVi = new Set();

    for (let i = 0; i < canvases.length; i++) {
        const canvas = canvases[i];

        let box = canvas.parentElement;
        let img = null;
        for (let up = 0; up < 5 && box; up++) {
            img = box.querySelector('img');
            if (img) break;
            box = box.parentElement;
        }
        if (!img || !box) continue;

        let username = usuarioDoAlt(img.getAttribute('alt'));
        if (!username) {
            const link = box.querySelector('a[href^="/"]');
            const href = link && link.getAttribute('href');
            const m = href && href.match(/^\/([A-Za-z0-9._]+)\/?$/);
            if (m) username = m[1];
        }
        if (!username || jaVi.has(username)) continue;

        const colorido = anelColorido(canvas);
        if (colorido === null) continue;         // não deu para ler: descarta

        jaVi.add(username);
        achados.push({
            id: '',
            username: username,
            fullName: '',
            pic: img.getAttribute('src') || '',
            novo: colorido
        });
    }

    return achados;
}

/* --------------- quem é Pessoa e quem é Conta ---------------------- */

// a bandeja do DOM só traz username; o id vem da varredura, que já mapeou
// todo mundo que você segue
function indicePorUsuario() {
    const idx = new Map();
    lastScan.following.forEach(function (a) {
        if (a.username) idx.set(a.username.toLowerCase(), a);
    });
    rowsById.forEach(function (a) {
        if (a.username) idx.set(a.username.toLowerCase(), a);
    });
    return idx;
}

async function classificarStories(lista) {
    const idx = indicePorUsuario();
    const faltando = [];

    lista.forEach(function (item) {
        const conhecido = idx.get(item.username.toLowerCase());
        if (conhecido) {
            if (!item.id) item.id = conhecido.id;
            if (!item.fullName) item.fullName = conhecido.fullName || '';
            if (!item.pic) item.pic = conhecido.pic || '';
        }

        const cached = item.id ? cacheGet(item.id) : null;
        if (cached) item.followers = cached.c;
        else if (conhecido && conhecido.followers !== null && conhecido.followers !== undefined) {
            item.followers = conhecido.followers;
        } else {
            item.followers = null;
            if (item.id) faltando.push(item);
        }
    });

    if (!faltando.length) return;

    // só o que sobrou vira requisição
    for (let i = 0; i < faltando.length; i++) {
        storiesSay('completando seguidores: ' + (i + 1) + '/' + faltando.length + '…');
        try {
            const profile = await fetchProfile(faltando[i].id);
            cacheSet(faltando[i].id, profile);
            faltando[i].followers = profile.c;
        } catch (e) {
            if (e && e.rateLimited) { readerBrake(); break; }
        }
    }

    cacheFlush();
}

function grupoDe(item) {
    // sem número conhecido fica em Pessoas, que é o caso mais comum
    return (item.followers !== null && item.followers !== undefined &&
            item.followers >= CFG.followerCut) ? 'contas' : 'pessoas';
}

/* ------------------------- montagem -------------------------------- */

function storyRow(item) {
    const row = document.createElement('div');
    row.className = 'row flex items-center justify-between';
    row.innerHTML =
        '<a href="https://www.instagram.com/' + encodeURIComponent(item.username) + '/" target="_blank" class="flex items-center">' +
            (item.pic ? '<img src="' + escapeHtml(item.pic) + '" loading="lazy">'
                      : '<span class="st-blank"></span>') +
            '<span class="flex flex-col">' +
                '<span>@' + escapeHtml(item.username) + '</span>' +
                (item.fullName ? '<span class="sub">' + escapeHtml(item.fullName) + '</span>' : '') +
            '</span>' +
        '</a>' +
        '<div class="flex items-center">' +
            (item.followers !== null && item.followers !== undefined
                ? '<span class="followers">' + shortNumber(item.followers) + '</span>'
                : '<span class="followers">—</span>') +
            '<button class="btn-sm st-open" data-user="' + escapeHtml(item.username) + '">Ver story</button>' +
        '</div>';
    return row;
}

function contar(grupo, estado) {
    return storiesData.filter(function (x) {
        return grupoDe(x) === grupo && (estado === 'novos' ? x.novo : !x.novo);
    }).length;
}

function pintarStories() {
    // contadores dos dois seletores
    panels.stories.querySelector('[data-g="pessoas"] b').innerText =
        contar('pessoas', 'novos') + contar('pessoas', 'vistos');
    panels.stories.querySelector('[data-g="contas"] b').innerText =
        contar('contas', 'novos') + contar('contas', 'vistos');

    panels.stories.querySelector('[data-s="novos"] b').innerText = contar(storiesGroup, 'novos');
    panels.stories.querySelector('[data-s="vistos"] b').innerText = contar(storiesGroup, 'vistos');

    panels.stories.querySelectorAll('[data-g]').forEach(function (b) {
        b.classList.toggle('active', b.dataset.g === storiesGroup);
    });
    panels.stories.querySelectorAll('[data-s]').forEach(function (b) {
        b.classList.toggle('active', b.dataset.s === storiesState);
    });

    const visiveis = storiesData.filter(function (x) {
        return grupoDe(x) === storiesGroup && (storiesState === 'novos' ? x.novo : !x.novo);
    });

    storiesList.innerHTML = '';
    visiveis.forEach(function (item) { storiesList.appendChild(storyRow(item)); });

    refreshTabCounts();
}

async function carregarStories() {
    const btn = panels.stories.querySelector('.st-go');
    btn.disabled = true;
    storiesList.innerHTML = '';
    storiesSay('lendo a barra de stories…');

    try {
        let lista = await trayFromApi();
        let origem = 'API';

        if (!lista || !lista.length) {
            lista = trayFromDom();
            origem = 'página';
        }

        if (!lista.length) {
            storiesData = [];
            pintarStories();
            storiesSay('Não encontrei a barra de stories. Ela só aparece na página inicial do ' +
                       'Instagram — role até o topo do feed e tente de novo.', 'warn');
            return;
        }

        await classificarStories(lista);

        storiesData = lista;
        pintarStories();

        storiesSay(lista.length + ' contas com story (lidas da ' + origem + ')' +
                   (origem === 'página'
                       ? ' — só o que está visível na barra; role a barra e recarregue para ver mais.'
                       : '.'));
    } catch (e) {
        storiesSay('Não foi possível ler os stories.', 'warn');
    } finally {
        btn.disabled = false;
    }
}

panels.stories.addEventListener('click', function (ev) {
    if (ev.target.closest('.st-go')) { carregarStories(); return; }

    const grupo = ev.target.closest('[data-g]');
    if (grupo) { storiesGroup = grupo.dataset.g; pintarStories(); return; }

    const estado = ev.target.closest('[data-s]');
    if (estado) { storiesState = estado.dataset.s; pintarStories(); return; }

    const abrir = ev.target.closest('.st-open');
    if (abrir) {
        bg({
            type: 'ns:open-viewer',
            info: {
                mode: 'story',
                username: abrir.dataset.user,
                url: 'https://www.instagram.com/stories/' + encodeURIComponent(abrir.dataset.user) + '/'
            }
        });
    }
});

/* ---------------------------- eventos ----------------------------- */

modal.addEventListener('click', function (ev) {
    if (suppressClick) { ev.preventDefault(); ev.stopPropagation(); return; }

    if (ev.target.matches('.modal-dialog') || ev.target.matches('.modal')) {
        modal.remove();
        document.body.style.overflowY = 'visible';
        running = false;
        closeScroller();
        cacheFlush();
        return;
    }

    const tab = ev.target.closest('.tab');
    if (tab) { selectTab(tab.dataset.tab); return; }

    if (ev.target.matches('.unfollow')) queueUnfollow(ev.target);
});

/* ---------------------------- arranque ---------------------------- */

if (!viewerId) {
    statusEl.innerHTML += '<span class="circle danger"></span> Login no Instagram não detectado.';
    return;
}

bg({ type: 'ns:register' });

statusEl.innerHTML += '<button class="btn-primary play" disabled>Carregar</button>';
playBtn = document.querySelector('.play');
playBtn.addEventListener('click', run);

fetch('https://www.instagram.com/api/v1/users/' + viewerId + '/info/', { headers: headersGet, credentials: 'include' })
    .then(function (res) {
        absorbClaim(res);
        if (res.status !== 200) throw httpError(res.status);
        return readJson(res);
    })
    .then(function (data) {
        const user = data && data.user ? data.user : null;
        if (!user) { note('danger', 'Não foi possível carregar os dados do seu perfil.'); return; }

        selfFollowers = user.follower_count || 0;
        selfFollowing = user.following_count || 0;

        if (selfFollowing > 5000) {
            showWarn('Você segue ' + selfFollowing.toLocaleString('pt-BR') + ' perfis. ' +
                'O carregamento é feito em ritmo lento de propósito, para o Instagram não interpretar como robô — pode levar vários minutos. ' +
                'Mantenha esta aba aberta.');
        }

        resetButton();
    })
    .catch(function (e) {
        note('danger', e && e.userMessage
            ? e.userMessage
            : 'Não foi possível carregar os dados do seu perfil (' + e + ')');
    });

}

init();
