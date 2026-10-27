"""Baixa os conjuntos do IBAMA úteis aos projetos e resume Paraná / municípios de interesse. Saída: data/_diag/ibama_pr.txt"""
import json, urllib.request, csv, io, zipfile, re, sys, unicodedata
from collections import Counter
csv.field_size_limit(10**9)
B = 'https://dadosabertos.ibama.gov.br'
def get(u, t=600): return urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=t).read()
def sa(t): return unicodedata.normalize('NFD', str(t or '')).encode('ascii', 'ignore').decode().upper().strip()
MUN = {'4113700': 'Londrina', '4109708': 'Ibaiti', '4128500': 'Wenceslau Braz', '4112801': 'Joaquim Távora'}
NOMES = {sa(n) for n in ['Dimas Budel', 'Luiz Renato de Oliveira Chueire', 'Mario Lucio Pozzan', 'Mauro Lucas Pozzan', 'Reginaldo Vilela', 'Frangos Pioneiro Industria e Comercio de Alimentos Ltda']}
pk = json.loads(get(B + '/api/3/action/package_search?fq=organization:ibama&rows=200'))['result']['results']
print('LICENÇAS DOS CONJUNTOS:', Counter((p.get('license_title') or p.get('license_id') or '?') for p in pk))
def ler(u):
    raw = get(u)
    if raw[:2] == b'PK':
        z = zipfile.ZipFile(io.BytesIO(raw)); out = []
        for n in z.namelist():
            if n.lower().endswith('.csv'): out.append((n, z.read(n)))
    else: out = [(u, raw)]
    for n, b in out:
        if b[:3] == b'\xef\xbb\xbf': b = b[3:]
        try: t = b.decode('utf-8')
        except UnicodeDecodeError: t = b.decode('latin-1')
        sep = ';' if t[:3000].count(';') > t[:3000].count(',') else ','
        yield n, list(csv.DictReader(io.StringIO(t), delimiter=sep))
ALVO = {
 'termo de embargo': ('UF', 'COD_MUNICIPIO', 'NOME_EMBARGADO', ['DAT_EMBARGO', 'SIT_DESEMBARGO', 'QTD_AREA_EMBARGADA', 'TIPO_AREA', 'DES_TAD']),
 'auto de infra': ('UF', 'COD_MUNICIPIO', 'NOME_INFRATOR', ['DAT_HORA_AUTO_INFRACAO', 'VAL_AUTO_INFRACAO', 'TIPO_INFRACAO', 'DES_AUTO_INFRACAO']),
 'Notificação': ('SIG_UF', 'COD_MUNICIPIO', 'NOME_NOTIFICADO', ['DAT_NOTIFICACAO', 'DES_ATIVIDADE_NOTIFICADO']),
 'CTF/APP': ('UF', 'Município', 'Razão Social', ['Descrição da atividade', 'Situação cadastral', 'Situação atual do último CR emitido']),
 'Supressão de Vegetação': ('UF', 'MUNICIPIO', None, []),
 'Uso Alternativo do Solo': ('UF', 'MUNICIPIO', None, []),
 'Corte de Árvores': ('UF', 'MUNICIPIO', None, []),
}
for p in pk:
    chave = next((k for k in ALVO if k.lower() in p['title'].lower()), None)
    if not chave or p['title'] == 'Termos de Embargo': continue
    ufc, munc, nomec, campos = ALVO[chave]
    r = next((r for r in p['resources'] if (r.get('format') or '').upper() in ('CSV', 'ZIP')), None)
    if not r: continue
    print(f"\n######## {p['title']} | licença: {p.get('license_title')} | atualizado {p.get('metadata_modified','')[:10]}")
    try:
        tot = 0; pr = []; cols = None
        for n, rows in ler(r['url']):
            if not rows: continue
            cols = cols or list(rows[0].keys())
            tot += len(rows)
            uk = next((c for c in rows[0] if c.upper() in (ufc.upper(), 'UF', 'SG_UF', 'SIG_UF', 'ESTADO')), None)
            pr += [x for x in rows if uk and sa(x.get(uk)) in ('PR', 'PARANA')]
        print(' colunas:', cols)
        print(' total Brasil:', tot, '| Paraná:', len(pr))
        mk = next((c for c in (cols or []) if c.upper() in (munc.upper(), 'COD_MUNICIPIO', 'MUNICIPIO', 'MUNICÍPIO', 'NOM_MUNICIPIO')), None)
        if mk:
            cm = Counter(x.get(mk) for x in pr)
            print(' municípios PR com mais registros:', cm.most_common(10))
            for cod, nome in MUN.items():
                n = sum(v for k, v in cm.items() if str(k) == cod or sa(k) == sa(nome))
                print(f'   {nome}: {n}')
        anos = Counter((str(x.get(campos[0]) or '')[:4] if campos else '') for x in pr)
        if campos: print(' por ano (PR):', sorted(anos.items())[-12:])
        if nomec and cols and nomec in cols:
            hit = [x for x in pr if sa(x.get(nomec)) in NOMES]
            print(' COINCIDÊNCIA COM GRANJAS/PIONEIRO:', [(x.get(nomec), {c: x.get(c) for c in campos}) for x in hit] or 'nenhuma')
        if 'SIT_DESEMBARGO' in (cols or []): print(' situação desembargo PR:', Counter(x.get('SIT_DESEMBARGO') for x in pr))
        if 'GEOM_AREA_EMBARGADA' in (cols or []): print(' com polígono (PR):', sum(1 for x in pr if (x.get('GEOM_AREA_EMBARGADA') or '').strip()))
        if 'DS_WKT' in (cols or []): print(' com geometria (PR):', sum(1 for x in pr if (x.get('DS_WKT') or x.get('WKT_GE_AREA_AUTUADA') or '').strip()))
    except Exception as e:
        print(' ERRO', e)
