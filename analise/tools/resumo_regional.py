"""Resumo quantitativo de um município (data/m/<código>/resumo.json) para o painel regional, que soma vários municípios.
Uso: python3 tools/resumo_regional.py [código ...]   (rodar dentro de analise/; sem código = todos os municípios processados)
Só números agregados: nenhum nome de titular, CPF ou CNPJ entra no resumo."""
import json, os, sys, math, glob
from collections import Counter

num = lambda t: float(str(t or '0').replace('.', '').replace(',', '.') or 0)
ler = lambda p: json.load(open(p)) if os.path.exists(p) else None
feats = lambda p: (ler(p) or {}).get('features', [])


def km_linhas(fs):
    tot = 0.0
    for f in fs:
        g = f.get('geometry') or {}
        partes = [g['coordinates']] if g.get('type') == 'LineString' else g.get('coordinates', []) if g.get('type') == 'MultiLineString' else []
        for l in partes:
            for (x1, y1), (x2, y2) in zip(l, l[1:]):
                dx = math.radians(x2 - x1) * math.cos(math.radians((y1 + y2) / 2)); dy = math.radians(y2 - y1)
                tot += 6371.0 * math.hypot(dx, dy)
    return round(tot, 1)


def gerar(D):
    cod = os.path.basename(D.rstrip('/'))
    cfg = ler(f'{D}/config.json') or {}
    nome = (cfg.get('cliente', {}).get('nome', '') or cod).replace('Análise Rural – ', '').replace('/PR', '')
    car = [f['properties'] for f in feats(f'{D}/car.geojson')]
    ativos = [p for p in car if p.get('situacao') != 'Cancelado']  # mesmo critério do painel do município (ativos + pendentes)
    area = lambda ps: round(sum(num(p.get('Área (ha)')) for p in ps), 1)
    cont = lambda ps, k: dict(Counter(p.get(k) or 'Sem informação' for p in ps))
    soma_area = lambda ps, k: {c: round(sum(num(p.get('Área (ha)')) for p in ps if (p.get(k) or 'Sem informação') == c), 1) for c in set(p.get(k) or 'Sem informação' for p in ps)}
    rl = sum(1 for p in ativos if any('Reserva Legal' in str(v) for k, v in p.items() if k.startswith('Pendência')))
    agua_lic = sum(1 for p in ativos if p.get('Uso da água × licença'))
    sig = [f['properties'] for f in feats(f'{D}/sigef.geojson')]
    alertas = [f['properties'] for f in feats(f'{D}/alertas.geojson')]
    emb = [f['properties'] for f in feats(f'{D}/embargos.geojson')]
    out = [f['properties'] for f in feats(f'{D}/outorgas_rural.geojson')]
    lic = [f['properties'] for f in feats(f'{D}/licencas.geojson')]
    mb = ler(f'{D}/mapbiomas_estatisticas.json') or {}
    r = {
        'codigo': cod, 'nome': nome, 'atualizado_em': cfg.get('atualizado_em'),
        'area_municipio_ha': mb.get('area_total_ha'),
        'car': {
            'imoveis_total': len(car), 'imoveis_ativos': len(ativos), 'area_ativos_ha': area(ativos),
            'status': cont(car, 'Status do CAR'), 'condicao': cont(ativos, 'Condição'),
            'porte': cont(ativos, 'Porte'), 'porte_area_ha': soma_area(ativos, 'Porte'),
            'faixa_vegetacao': cont(ativos, 'faixa_veg'), 'pendencia_nivel': cont(ativos, 'pendencia_nivel'),
            'georreferenciamento': cont(ativos, 'Georreferenciamento SIGEF'),
            'possivel_deficit_rl': rl, 'atividade_sem_outorga': agua_lic,
            'com_alerta': sum(1 for p in ativos if p.get('Alertas MapBiomas')),
            'com_embargo_vigente': sum(1 for p in ativos if str(p.get('Embargo IBAMA') or '').startswith('Vigente')),
        },
        'sigef': {'parcelas': len(sig), 'area_ha': area(sig)},
        # o arquivo tem uma linha por alerta × imóvel: conta cada alerta uma vez e soma só a área dentro dos imóveis do CAR
        'alertas': {'n': len({p.get('Código do alerta') or p.get('nome') for p in alertas}), 'area_ha': round(sum(num(p.get('Área no imóvel (ha)')) for p in alertas), 1),
                    'imoveis': len({p.get('Imóvel (CAR)') for p in alertas if num(p.get('Área no imóvel (ha)')) > 0})},
        'embargos': {'n': len(emb), 'situacao': cont(emb, 'Situação')},
        'outorgas_rurais': {'n': len(out), 'tipo': cont(out, 'grupo')},
        'licencas': {'n': len(lic), 'tipo': cont(lic, 'grupo'), 'situacao': cont(lic, 'situacao'),
                     'vencidas_sem_renovacao': len(feats(f'{D}/licencas_vencidas.geojson'))},
        'mineracao': {'n': len(feats(f'{D}/mineracao.geojson')), 'fase': cont([f['properties'] for f in feats(f'{D}/mineracao.geojson')], 'grupo'),
                      'imoveis': sum(1 for p in ativos if p.get('Mineração (ANM)'))},
        'risco_sgb': {'n': len(feats(f'{D}/risco_sgb.geojson')), 'mapeado': bool((ler(f'{D}/risco_sgb.geojson') or {}).get('mapeado')),
                      'imoveis': sum(1 for p in ativos if p.get('Risco geológico (SGB)'))},
        'barragens': len(feats(f'{D}/barragens.geojson')),
        'massas_dagua': len(feats(f'{D}/massas_dagua.geojson')),
        'nascentes': len(feats(f'{D}/nascentes_fbds.geojson')),
        'rios_km': km_linhas(feats(f'{D}/rios_fbds.geojson')),
        'uso_solo': {'ano': mb.get('ano'), 'fonte': mb.get('fonte'), 'grupos': {g['grupo']: g['area_ha'] for g in mb.get('grupos', [])}},
    }
    json.dump(r, open(f'{D}/resumo.json', 'w'), ensure_ascii=False, indent=1)
    return r


if __name__ == '__main__':
    alvo = sys.argv[1:] or [os.path.basename(p) for p in glob.glob('data/m/*') if os.path.isdir(p)]
    for c in alvo:
        r = gerar(f'data/m/{c}'); print(c, r['nome'], r['car']['imoveis_ativos'], 'imóveis', r['car']['area_ativos_ha'], 'ha')
