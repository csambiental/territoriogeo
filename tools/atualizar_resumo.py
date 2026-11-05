"""Atualiza os números do resumo (topo do painel) a partir dos dados gerados."""
import json, datetime
cfg = json.load(open('data/fazendas.json'))
c = json.load(open('data/clima/clima_londrina.json'))['resumo']
b = json.load(open('data/calor/bairros_calor.geojson'))['features']
ult = int(c['periodo'][-4:])
fmt = lambda v, n=1: f'{v:.{n}f}'.replace('.', ',')
t = [f['properties']['Temperatura média da superfície (°C)'] for f in b]
cfg['resumo'] = [
    {'valor': f"+{fmt(c[f'temp_{ult-9}_{ult}'] - c['temp_1981_1990'])} °C", 'rotulo': f'temperatura média (1981–90 → {ult-9}–{str(ult)[2:]})'},
    {'valor': f"{fmt(c['dias32_1981_1990'], 0)} → {fmt(c[f'dias32_{ult-9}_{ult}'], 0)}", 'rotulo': 'dias por ano com máxima ≥ 32 °C'},
    {'valor': f'{fmt(max(t) - min(t))} °C', 'rotulo': 'de diferença na superfície entre o bairro mais quente e o mais fresco'}]
cfg['atualizado_em'] = datetime.date.today().isoformat()
json.dump(cfg, open('data/fazendas.json', 'w'), ensure_ascii=False, indent=1)
print(cfg['resumo'])
