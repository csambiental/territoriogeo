"""Corrige nomes de rios da base de ottobacias da ANA/SNIRH, que chegam com acentos trocados por caracteres aleatórios
(ex.: 'Ribeir4o', 'Seo Pedro', 'Bgua Branca')."""
import re
REGRAS = [
    (r'\bRibeir[^\sa-z]?[a-z]?o\b|\bRibeir.o\b', 'Ribeirão'), (r'\bRibeirao\b', 'Ribeirão'), (r'\bC.rrego\b', 'Córrego'),
    (r'^Ribeir$', 'Ribeirão (nome incompleto na base)'), (r'\b[^\sA-Za-z]?[A-Za-z_]gua\b', 'Água'), (r'\b_gua\b', 'Água'),
    (r'\bS.o\b', 'São'), (r'\bIva\w?$', 'Ivaí'), (r'\bJacar.$', 'Jacaré'), (r'\bCurimbat.$', 'Curimbatá'), (r'\bPi.arra\b', 'Piçarra'),
    (r'\bTr.s\b', 'Três'), (r'\bTr$', 'Três (nome incompleto na base)'), (r'\bMarumbi\b', 'Marumbi'), (r'\bTib.gi\b', 'Tibagi'),
    (r'\bPiraj.\b', 'Pirajú'), (r'\bInhacor.\b', 'Inhacorá'), (r'\bJata.\b', 'Jataí'),
]
def rio(n):
    n = re.sub(r'\s+', ' ', (n or '').strip())
    if not n: return ''
    for a, b in REGRAS: n = re.sub(a, b, n)
    return n
def microbacia(n):
    r = rio(n)
    if not r: return 'Microbacia de curso sem nome'
    return f"Microbacia {'da' if r.startswith('Água') else 'do'} {r}"
if __name__ == '__main__':
    import json, sys
    for p in sys.argv[1:]:
        d = json.load(open(p))
        for f in d['features']:
            q = f['properties']; q['rio'] = rio(q.get('rio')); q['nome'] = microbacia(q.get('rio'))
        json.dump(d, open(p, 'w'), ensure_ascii=False, separators=(',', ':'))
        print(p, sorted({f['properties']['nome'] for f in d['features']}))
