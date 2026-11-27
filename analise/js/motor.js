// Motor do Raio-X: o mapa é aberto; a análise e o relatório só carregam com a senha da CS.
// O código do motor fica cifrado (AES-GCM) em data/motor/motor.bin; cada senha cadastrada abre a chave em data/motor/chaves.json.
(function () {
    const BASE = 'data/motor/';
    const ARQ_ABERTOS = ['js/itr.js?v=20261127a', 'js/cardecl.js?v=20261125a', 'js/raiox.js?v=20261127d'];   // só enquanto o motor cifrado não existir
    let carregando = null;
    const hex = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
    const b64 = u => btoa(String.fromCharCode(...new Uint8Array(u)));
    const deb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    const ss = { get: k => { try { return sessionStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) { } }, del: k => { try { sessionStorage.removeItem(k); } catch (e) { } } };

    // scripts injetados depois da página pronta: os "DOMContentLoaded" deles rodam na hora
    async function comDomPronto(fn) {
        const orig = document.addEventListener;
        document.addEventListener = function (t, f, o) { if (t === 'DOMContentLoaded' && document.readyState !== 'loading') return setTimeout(f, 0); return orig.call(this, t, f, o); };
        try { await fn(); } finally { setTimeout(() => { document.addEventListener = orig; }, 0); }
    }
    const injetar = codigos => comDomPronto(() => { for (const c of codigos) { const s = document.createElement('script'); s.textContent = c.codigo + `\n//# sourceURL=motor/${c.nome}`; document.head.appendChild(s); } });
    function scriptAberto(src) { return new Promise((ok, erro) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = erro; document.head.appendChild(s); }); }

    async function abrirComChave(K, cifrado) {
        const u = new Uint8Array(cifrado);
        const txt = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.slice(0, 12) }, K, u.slice(12)));
        return JSON.parse(txt);
    }
    async function chaveDaSenha(senha, cfg) {
        const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(senha), 'PBKDF2', false, ['deriveKey']);
        for (const c of cfg.chaves) {
            const kw = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: hex(c.sal), iterations: cfg.iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
            try {
                const bruto = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: hex(c.iv) }, kw, hex(c.k));
                return { K: await crypto.subtle.importKey('raw', bruto, 'AES-GCM', false, ['decrypt']), bruto };
            } catch (e) { /* outra senha */ }
        }
        return null;
    }

    function pedirSenha(erro) {
        return new Promise(ok => {
            let d = document.getElementById('motorDlg');
            if (!d) {
                d = document.createElement('dialog'); d.id = 'motorDlg'; d.className = 'doc-dialog';
                d.style.cssText = 'max-width:380px;width:92vw;height:auto;padding:0';
                d.innerHTML = `<form method="dialog" style="padding:18px 20px;display:flex;flex-direction:column;gap:10px">
                    <h3 style="margin:0">Raio-X – acesso da CS</h3>
                    <p class="hint" style="margin:0">O mapa é aberto. Para analisar imóveis e gerar relatórios, digite a sua senha.</p>
                    <input type="password" id="motorSenha" autocomplete="current-password" placeholder="Senha" required style="padding:8px;font-size:1rem">
                    <p id="motorMsg" style="color:#c62828;margin:0;min-height:1em;font-size:.85rem"></p>
                    <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn" id="motorCancelar">Cancelar</button><button class="btn btn-solid" id="motorEntrar">Entrar</button></div></form>`;
                document.body.appendChild(d);
            }
            const inp = d.querySelector('#motorSenha'), msg = d.querySelector('#motorMsg');
            msg.textContent = erro || ''; inp.value = '';
            d.querySelector('#motorCancelar').onclick = () => { d.close(); ok(null); };
            d.querySelector('form').onsubmit = ev => { ev.preventDefault(); const v = inp.value; inp.value = ''; d.close(); ok(v); };
            d.showModal(); inp.focus();
        });
    }

    async function carregar() {
        let cfg = null, cifrado = null;
        try {
            const [rc, rb] = await Promise.all([fetch(BASE + 'chaves.json', { cache: 'no-cache' }), fetch(BASE + 'motor.bin', { cache: 'no-cache' })]);
            if (rc.ok && rb.ok) { cfg = await rc.json(); cifrado = await rb.arrayBuffer(); }
        } catch (e) { }
        if (!cfg) { await comDomPronto(async () => { for (const s of ARQ_ABERTOS) await scriptAberto(s); }); return true; }   // ainda sem motor cifrado
        // chave guardada nesta aba (não precisa digitar de novo até fechar o navegador)
        const guardada = ss.get('cs_motor');
        if (guardada) {
            try { const K = await crypto.subtle.importKey('raw', deb64(guardada), 'AES-GCM', false, ['decrypt']); await injetar((await abrirComChave(K, cifrado)).arquivos); return true; }
            catch (e) { ss.del('cs_motor'); }
        }
        let erro = '';
        for (let t = 0; t < 5; t++) {
            const senha = window.RX_SENHA_AUTO || await pedirSenha(erro);
            if (!senha) return false;
            const r = await chaveDaSenha(senha, cfg);
            if (r) { const m = await abrirComChave(r.K, cifrado); ss.set('cs_motor', b64(r.bruto)); await injetar(m.arquivos); return true; }
            if (window.RX_SENHA_AUTO) { console.error('senha automática inválida'); return false; }
            erro = 'Senha incorreta.';
        }
        return false;
    }
    window.rxGarantirMotor = function () {
        if (typeof window.gerarRelatorioRaiox === 'function') return Promise.resolve(true);
        if (!carregando) carregando = carregar().then(ok => { if (!ok) carregando = null; return ok; }, e => { carregando = null; console.error(e); return false; });
        return carregando;
    };
    // pontos de entrada usados pelo mapa: carregam o motor e chamam a função verdadeira
    window.analisarImovel = async function (...a) {
        const stub = window.analisarImovel;
        if (!(await window.rxGarantirMotor())) return;
        if (window.analisarImovel !== stub) return window.analisarImovel(...a);
    };
    // link com ?car= (QR antigo / consulta automática): pede a senha e abre o Raio-X
    const car = new URLSearchParams(location.search).get('car');
    if (car) {
        const tentar = n => { if (typeof dadosGerais !== 'undefined' && dadosGerais.raiox && typeof map !== 'undefined' && map.loaded && map.loaded()) window.rxGarantirMotor(); else if (n < 60) setTimeout(() => tentar(n + 1), 1000); };
        setTimeout(() => tentar(0), 1500);
    }
})();
