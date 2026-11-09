"""Estatísticas de georreferenciamento (SIGEF/INCRA) e da situação do CAR para o painel do mapa.

Uso direto (mapa de Londrina):
    python3 analise/tools/estat_geo.py data/fazendas.json data/municipio_londrina.geojson data/car/imoveis_londrina.geojson data/fundiario/sigef_londrina.geojson
Também é chamado pela etapa 'config' de analise/tools/municipio.py.
"""
import json, sys
from shapely.geometry import shape
from shapely.ops import unary_union
from shapely import transform as _tr
import numpy as np
from pyproj import Transformer

UTM = Transformer.from_crs(4326, 31982, always_xy=True).transform
SIT_SIGEF = [('Registrada', 'Registrada em cartório', '#2e7d32'),
             ('Titulada, não registrada', 'Titulada, aguardando registro', '#29b6f6'),
             ('Não titulada', 'Certificada no INCRA, sem registro (em processo)', '#ff9800')]
SIT_CAR = ['Analisado – em conformidade', 'Analisado – regularização ambiental pendente', 'Analisado – notificação pendente', 'Em análise', 'Aguardando análise']
br = lambda v, c=1: f'{v:,.{c}f}'.replace(',', 'X').replace('.', ',').replace('X', '.')


def _geom(f):
    try:
        return _tr(shape(f['geometry']).buffer(0), lambda xy: np.column_stack(UTM(xy[:, 0], xy[:, 1])))
    except Exception:
        return None


def calcular(mun_fc, car_fc, sigef_fc):
    mun = unary_union([g for g in map(_geom, mun_fc['features']) if g])
    ativos = [f for f in car_fc['features'] if f['properties'].get('situacao') != 'Cancelado']
    car_g = [(f['properties'].get('situacao') or 'Sem situação', _geom(f)) for f in ativos]
    car_u = unary_union([g for _, g in car_g if g]).intersection(mun)
    a_mun, a_car = mun.area / 1e4, car_u.area / 1e4
    # SIGEF: área sem contar sobreposição, cada situação na ordem de prioridade (registrada > titulada > em processo)
    por_sit, ja = [], None
    for chave, rot, cor in SIT_SIGEF:
        fs = [f for f in sigef_fc['features'] if f['properties'].get('Situação') == chave]
        u = unary_union([g for g in map(_geom, fs) if g]).intersection(mun) if fs else None
        bruta = u.area / 1e4 if u is not None else 0
        if u is not None and ja is not None: u = u.difference(ja)
        ha = u.area / 1e4 if u is not None else 0
        ha_car = u.intersection(car_u).area / 1e4 if u is not None else 0
        ja = u if ja is None else (ja.union(u) if u is not None else ja)
        por_sit.append({'chave': chave, 'rotulo': rot, 'cor': cor, 'parcelas': len(fs), 'ha': ha, 'ha_car': ha_car, 'ha_bruta': bruta})
    a_sig = ja.area / 1e4 if ja is not None else 0
    a_sig_car = ja.intersection(car_u).area / 1e4 if ja is not None else 0
    # CAR por situação (área cadastrada, sem dupla contagem de sobreposições não é necessário aqui: soma declarada)
    car_sit = {}
    for s, g in car_g:
        if g is None: continue
        d = car_sit.setdefault(s, [0, 0.0]); d[0] += 1; d[1] += g.area / 1e4
    return {'area_municipio_ha': a_mun, 'area_car_ha': a_car, 'area_sigef_ha': a_sig, 'area_sigef_no_car_ha': a_sig_car,
            'pct_mun_sigef': 100 * a_sig / a_mun, 'pct_car_sigef': 100 * a_sig_car / max(a_car, 1e-9), 'sigef': por_sit,
            'car': car_sit, 'imoveis_car': len(ativos)}


def aplicar(cfg, e):
    """Coloca os números no config do mapa: cartão de resumo, gráficos do painel e legenda da camada SIGEF."""
    resumo = [r for r in cfg.get('resumo', []) if 'georreferenciad' not in r.get('rotulo', '')]
    resumo.append({'valor': f"{br(e['pct_car_sigef'], 0)}%", 'rotulo': 'da área do CAR georreferenciada no SIGEF/INCRA'})
    cfg['resumo'] = resumo
    pg = cfg.setdefault('programa', {'titulo': 'Sobre esta análise', 'texto': '', 'etapas': []})
    gr = [g for g in pg.get('graficos', []) if not g.get('id', '').startswith('geo-')]
    tot_car = sum(v[1] for v in e['car'].values()) or 1
    gr.append({'id': 'geo-car', 'titulo': 'Situação do CAR – % da área cadastrada',
               'fonte': f"Fonte: SICAR · {br(e['imoveis_car'], 0)} imóveis ativos, {br(tot_car, 0)} ha declarados (com sobreposições)",
               'itens': [{'rotulo': f"{s} ({e['car'][s][0]})", 'pct': round(100 * e['car'][s][1] / tot_car, 2)} for s in SIT_CAR + [k for k in e['car'] if k not in SIT_CAR] if s in e['car']]})
    itens = [{'rotulo': f"{x['rotulo']} ({x['parcelas']} parcelas{'; área já contada como registrada' if x['ha_bruta'] > 1 and x['ha'] < 0.5 * x['ha_bruta'] else ''})", 'pct': round(100 * x['ha_car'] / max(e['area_car_ha'], 1e-9), 2)} for x in e['sigef'] if x['parcelas']]
    itens.append({'rotulo': 'Sem georreferenciamento certificado', 'pct': round(max(0, 100 - e['pct_car_sigef']), 2)})
    gr.append({'id': 'geo-sigef', 'titulo': 'Georreferenciamento SIGEF/INCRA – % da área do CAR',
               'fonte': f"Fonte: INCRA/SIGEF · {br(e['area_sigef_ha'], 0)} ha certificados = {br(e['pct_car_sigef'])}% da área rural do CAR e {br(e['pct_mun_sigef'])}% do território do município",
               'itens': itens})
    pg['graficos'] = gr
    for cam in cfg.get('camadas_opcionais', []):
        if cam.get('id') == 'sigef':
            nota = lambda x: ' (quase toda sobre áreas já registradas)' if x['ha_bruta'] > 1 and x['ha'] < 0.5 * x['ha_bruta'] else ''
            cam['legenda_itens'] = [{'rotulo': f"{x['rotulo']} – {x['parcelas']} parcelas, {br(x['ha_bruta'], 0)} ha{nota(x)}", 'cor': x['cor']} for x in e['sigef'] if x['parcelas']]
            cam['nome'] = f"Imóveis certificados SIGEF/INCRA ({br(e['pct_car_sigef'], 0)}% da área do CAR)"
    return cfg


if __name__ == '__main__':
    cfg_p, mun_p, car_p, sig_p = sys.argv[1:5]
    e = calcular(*(json.load(open(p)) for p in (mun_p, car_p, sig_p)))
    print(json.dumps({k: v for k, v in e.items() if k != 'car'}, ensure_ascii=False, indent=1, default=str))
    cfg = aplicar(json.load(open(cfg_p)), e)
    json.dump(cfg, open(cfg_p, 'w'), ensure_ascii=False, indent=1)
