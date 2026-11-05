"""Série climática de Londrina (reanálise ERA5 via Open-Meteo, CC BY 4.0) -> data/clima/*.json
Indicadores anuais: temperatura média, dias de calor, chuva total, chuvas extremas, rajadas de vento; rosa dos ventos."""
import json, urllib.request, datetime, math, statistics, os
LAT, LON = -23.31, -51.16
hoje = datetime.date.today(); fim = datetime.date(hoje.year - 1, 12, 31)
url = ('https://archive-api.open-meteo.com/v1/archive?latitude=%s&longitude=%s&start_date=1981-01-01&end_date=%s'
       '&daily=temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,et0_fao_evapotranspiration'
       '&timezone=America%%2FSao_Paulo') % (LAT, LON, fim.isoformat())
d = json.load(urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'clima-londrina-biosimos'}), timeout=300))['daily']
os.makedirs('data/clima', exist_ok=True)
anos = {}
for i, dia in enumerate(d['time']):
    a = int(dia[:4]); r = anos.setdefault(a, {'tmed': [], 'tmax': [], 'tmin': [], 'chuva': [], 'raj': []})
    mes = int(dia[5:7])
    for k, c in (('et0', 'et0_fao_evapotranspiration'),): 
        if d[c][i] is not None: r.setdefault('et0', []).append(d[c][i])
    r.setdefault('safra_tmax', []); r.setdefault('safra_chuva', [])
    if dia[5:] == '10-01': r['safra_chuva'].append(99)  # separa jan–mar do início da safra seguinte
    if mes in (10, 11, 12, 1, 2, 3):
        r['safra_tmax'].append(d['temperature_2m_max'][i]); r['safra_chuva'].append(d['precipitation_sum'][i] or 0)
    for k, c in (('tmed', 'temperature_2m_mean'), ('tmax', 'temperature_2m_max'), ('tmin', 'temperature_2m_min'), ('chuva', 'precipitation_sum'), ('raj', 'wind_gusts_10m_max')):
        v = d[c][i]
        if v is not None: r[k].append(v)
def veranico(chuvas):
    m = c = 0
    for v in chuvas:
        c = c + 1 if v < 1 else 0; m = max(m, c)
    return m
serie = []
for a in sorted(anos):
    r = anos[a]
    if len(r['tmed']) < 360: continue
    serie.append({'ano': a, 'temp_media': round(statistics.mean(r['tmed']), 2), 'tmax_media': round(statistics.mean(r['tmax']), 2),
                  'dias_32': sum(1 for v in r['tmax'] if v >= 32), 'dias_35': sum(1 for v in r['tmax'] if v >= 35),
                  'noites_quentes': sum(1 for v in r['tmin'] if v >= 22), 'chuva_total': round(sum(r['chuva'])),
                  'dias_chuva_50': sum(1 for v in r['chuva'] if v >= 50), 'chuva_max_dia': round(max(r['chuva']), 1),
                  'dias_rajada_60': sum(1 for v in r['raj'] if v >= 60), 'rajada_max': round(max(r['raj']), 1),
                  # indicadores rurais
                  'geadas': sum(1 for v in r['tmin'] if v <= 3), 'tmin_ano': round(min(r['tmin']), 1),
                  'et0': round(sum(r.get('et0', []))), 'balanco_hidrico': round(sum(r['chuva']) - sum(r.get('et0', []))),
                  'veranico_max': veranico(r['safra_chuva']), 'dias_35_safra': sum(1 for v in r['safra_tmax'] if v is not None and v >= 35),
                  'dias_chuva_30': sum(1 for v in r['chuva'] if v >= 30)})
def tendencia(campo):
    xs = [s['ano'] for s in serie]; ys = [s[campo] for s in serie]; n = len(xs); mx, my = sum(xs) / n, sum(ys) / n
    b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sum((x - mx) ** 2 for x in xs)
    return round(b * 10, 2)   # por década
def media(campo, a0, a1): v = [s[campo] for s in serie if a0 <= s['ano'] <= a1]; return round(sum(v) / len(v), 1)
ult = serie[-1]['ano']
resumo = {'periodo': f"{serie[0]['ano']}–{ult}", 'fonte': 'ERA5 (ECMWF/Copernicus) via Open-Meteo – célula de ~25 km sobre Londrina',
          'tendencia_temp_decada': tendencia('temp_media'), 'tendencia_dias32_decada': tendencia('dias_32'),
          'tendencia_chuva50_decada': tendencia('dias_chuva_50'),
          'dias32_1981_1990': media('dias_32', 1981, 1990), f'dias32_{ult-9}_{ult}': media('dias_32', ult - 9, ult),
          'temp_1981_1990': media('temp_media', 1981, 1990), f'temp_{ult-9}_{ult}': media('temp_media', ult - 9, ult),
          'chuva50_1981_1990': media('dias_chuva_50', 1981, 1990), f'chuva50_{ult-9}_{ult}': media('dias_chuva_50', ult - 9, ult),
          'geadas_1981_1990': media('geadas', 1981, 1990), f'geadas_{ult-9}_{ult}': media('geadas', ult - 9, ult),
          'veranico_1981_1990': media('veranico_max', 1981, 1990), f'veranico_{ult-9}_{ult}': media('veranico_max', ult - 9, ult),
          'balanco_1981_1990': media('balanco_hidrico', 1981, 1990), f'balanco_{ult-9}_{ult}': media('balanco_hidrico', ult - 9, ult),
          'dias35safra_1981_1990': media('dias_35_safra', 1981, 1990), f'dias35safra_{ult-9}_{ult}': media('dias_35_safra', ult - 9, ult)}
# rosa dos ventos (direção dominante diária × velocidade máxima diária), últimos 10 anos
setores = ['N', 'NE', 'L', 'SE', 'S', 'SO', 'O', 'NO']; faixas = [(0, 15), (15, 25), (25, 35), (35, 999)]
rosa = {s: [0] * len(faixas) for s in setores}; n = 0
for i, dia in enumerate(d['time']):
    if int(dia[:4]) < ult - 9: continue
    dr, vel = d['wind_direction_10m_dominant'][i], d['wind_speed_10m_max'][i]
    if dr is None or vel is None: continue
    s = setores[int(((dr + 22.5) % 360) // 45)]; f = next(j for j, (a, b) in enumerate(faixas) if a <= vel < b)
    rosa[s][f] += 1; n += 1
rosa = {'faixas_kmh': ['< 15', '15–25', '25–35', '≥ 35'], 'setores': setores, 'percentual': {s: [round(100 * v / n, 1) for v in rosa[s]] for s in setores}, 'periodo': f'{ult-9}–{ult}'}
# maiores chuvas diárias registradas
top = sorted(((d['precipitation_sum'][i] or 0, d['time'][i]) for i in range(len(d['time']))), reverse=True)[:10]
json.dump({'resumo': resumo, 'serie': serie, 'rosa_ventos': rosa, 'maiores_chuvas': [{'data': t, 'mm': round(v, 1)} for v, t in top]},
          open('data/clima/clima_londrina.json', 'w'), ensure_ascii=False, indent=1)
print(json.dumps(resumo, ensure_ascii=False, indent=1))
