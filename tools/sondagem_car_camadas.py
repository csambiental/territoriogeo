"""Sondagem: estrutura da base temática do CAR (PR) baixada do SICAR e guardada no Drive."""
import sys, subprocess, zipfile, os
OUT = sys.argv[1]
subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', 'gdown', 'pyogrio', 'pandas'], check=True)
import gdown, pyogrio
ARQ = {'USO_RESTRITO': '1Zu0pA1pEJ5kYXh2NtzByu-oO6VTqInNx', 'AREA_POUSIO': '1buJTgY4FJJ_j9tZg6TDVcnMLns5aJ227'}
for nome, fid in ARQ.items():
    z = f'/tmp/{nome}.zip'
    gdown.download(id=fid, output=z, quiet=True)
    print('=====', nome, os.path.getsize(z))
    with zipfile.ZipFile(z) as zf:
        for i in zf.infolist()[:30]: print('  ', i.filename, i.file_size)
        shp = [i.filename for i in zf.infolist() if i.filename.lower().endswith('.shp')]
        inner = [i.filename for i in zf.infolist() if i.filename.lower().endswith('.zip')]
    alvo = f'/vsizip/{z}/{shp[0]}' if shp else (f'/vsizip//vsizip/{z}/{inner[0]}' if inner else None)
    print('alvo', alvo)
    if not alvo: continue
    try:
        info = pyogrio.read_info(alvo); print(info)
        df = pyogrio.read_dataframe(alvo, max_features=5); print(df.drop(columns='geometry').to_string()[:3000]); print(df.crs)
    except Exception as e: print('erro', e)
