"""Teste: imagens numeradas do Raio-X (SIGEF, sobreposições, pontos) em tela de celular e de computador."""
import sys, os, base64
from playwright.sync_api import sync_playwright
OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True)
GL = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
CARS = ['PR-4102406-C8D23903208A41BEA3D474F0F47A7499', 'PR-4102406-667A36347B9E423B9856AF425CBAFCD4']
with sync_playwright() as p:
    b = p.chromium.launch(args=GL)
    for tela, vp in [('celular', {'width': 390, 'height': 844}), ('pc', {'width': 1400, 'height': 900})]:
        for car in CARS:
            pg = b.new_page(viewport=vp); erros = []; pg.on('pageerror', lambda e: erros.append(str(e)))
            pg.goto(f'https://csambiental.github.io/territoriogeo/analise/index.html?m=4102406&car={car.replace("-", "")}')
            pg.wait_for_function("() => typeof RX !== 'undefined' && RX.ultimo && RX.ultimo.sigef", timeout=180000); pg.wait_for_timeout(1500)
            fotos = pg.evaluate("""async () => { const u = RX.ultimo;
                const parc = (u.sigef || []).slice(0, 15);
                return { sig: parc.length ? await rxFotoSigef(u.alvo, parc) : null, n: parc.length }; }""")
            if fotos['sig']: open(f"{OUT}/{tela}_{car[-6:]}_sigef.jpg", 'wb').write(base64.b64decode(fotos['sig'].split(',')[1]))
            print(tela, car, 'parcelas', fotos['n'], 'erros', erros, flush=True)
            pg.close()
    b.close()
