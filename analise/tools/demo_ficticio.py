"""Imóvel FICTÍCIO para demonstrações (não corresponde a nenhum imóvel real).

Gera data/m/<cod>/demo.geojson com o imóvel de exemplo e as situações que o Raio-X deve encontrar
(vizinho sobreposto, parcela SIGEF, outorga perto de vencer, açude sem barragem cadastrada, licenças),
todas inventadas. No Raio-X desse imóvel só estas camadas fictícias são usadas, para não expor ninguém.
Uso: python3 demo_ficticio.py <cod_ibge> <lon> <lat>
"""
import json, sys, math, datetime
from shapely.geometry import Polygon, Point, mapping
from shapely import affinity

cod, lon0, lat0 = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
KX, KY = 1 / (111320 * math.cos(math.radians(lat0))), 1 / 110574  # metros -> graus


def geo(g):
    g = affinity.rotate(g, 18, origin=(0, 0))
    return affinity.affine_transform(g, [KX, 0, 0, KY, lon0, lat0])


hoje = datetime.date.today()
d = lambda dias: (hoje + datetime.timedelta(days=dias)).strftime('%d/%m/%Y')
F = lambda camada, g, **p: {'type': 'Feature', 'geometry': mapping(geo(g)), 'properties': {'camada': camada, 'ficticio': True, **p}}

imovel = Polygon([(-380, -300), (330, -340), (360, 260), (40, 330), (-360, 250)])        # ≈ 45 ha
vizinho = Polygon([(300, -360), (900, -380), (920, 300), (330, 270)])                   # invade ~30 m na divisa leste
sigef = Polygon([(-380, -300), (60, -320), (60, 320), (40, 330), (-360, 250)])            # cobre ~60% do imóvel
acude = Point(-180, -120).buffer(55).union(Point(-130, -110).buffer(40))                  # ≈ 1,3 ha... reduzido abaixo
acude = affinity.scale(acude, 0.75, 0.75)                                                  # ≈ 0,8 ha
sede = Point(120, 60)
poco = Point(150, 20)

area_ha = geo(imovel).area / (KX * KY) / 1e4  # aproximado (graus -> m²)
feats = [
    F('imovel', imovel, nome='PR-4108700-EXEMPLO-FICTICIO', situacao='Analisado – notificação pendente', **{
        'Imóvel de exemplo': 'FICTÍCIO – criado só para demonstração, não corresponde a nenhum imóvel real',
        'Área (ha)': f'{area_ha:.2f}'.replace('.', ','), 'Módulos fiscais': f'{area_ha / 18:.2f}'.replace('.', ','), 'Porte': 'Pequena (até 4 MF)',
        'Status do CAR': 'Ativo', 'Condição': 'Analisado – notificação pendente', 'Tipo': 'Imóvel rural',
        'Uso do solo 2023 – Agricultura (%)': '66,8', 'Uso do solo 2023 – Vegetação arbórea (%)': '16,4', 'Uso do solo 2023 – Pastagem e campos (%)': '12,9',
        'Uso do solo 2023 – Água (%)': '1,8', 'Uso do solo 2023 – Outras áreas (%)': '2,1', 'veg_nativa_pct': 16.4, 'faixa_veg': '10% a 20%',
        'Georreferenciamento SIGEF': 'Parcialmente no SIGEF', 'pendencia_nivel': 'Prioridade alta', 'pendencias_n': 2,
        'Pendência 1': 'CAR analisado com notificação do órgão sem resposta', 'Pendência 2': 'Vegetação nativa abaixo de 20% (Reserva Legal)'}),
    F('car', vizinho, nome='PR-4108700-VIZINHO-FICTICIO', situacao='Aguardando análise'),
    F('sigef', sigef, nome='Parcela SIGEF fictícia', Situação='Registrada', **{'Matrícula / registro': 'Matrícula 0.000 (fictícia)'}),
    F('massa', acude, nome='Açude', grupo='Açude / represa (artificial)', Tipo='Artificial (açude, represa, reservatório)',
      **{'Área (ha)': f"{geo(acude).area / (KX * KY) / 1e4:.2f}".replace('.', ',')}),
    F('outorga', poco, nome='TITULAR FICTÍCIO', grupo='Poço (água subterrânea)', Interferência='Captação subterrânea (Poço tubular)',
      Documento='Portaria de outorga de direito', Situação='Deferida', Finalidade='Dessedentação animal, Consumo humano',
      **{'Portaria / declaração': '00000/2023/OD-GOUT', 'Vazão máxima (m³/h)': '2,50', 'Publicação': '10/03/2023', 'Vencimento': d(120)}),
    F('licenca', sede, nome='TITULAR FICTÍCIO', grupo='Dispensa de licenciamento', situacao='Vigente', Situação='Vigente',
      Modalidade='DLAE – Dispensa de Licenciamento Ambiental Estadual', Atividade='Bovinocultura de leite', **{'Atividade específica': 'Criação de animais em lactação semiconfinados',
      'Nº do documento': '000.001', 'Emissão': '15/04/2024', 'Validade': '15/04/2034', 'Protocolo': '00.000.001-0', 'Localização': 'Fictícia'}),
    F('licenca', Point(60, 140), nome='TITULAR FICTÍCIO', grupo='Licença Simplificada', situacao='Vencida', Situação='Vencida',
      Modalidade='LAS – Licença Ambiental Simplificada', Atividade='Avicultura de corte', **{'Atividade específica': 'Criação de frangos para corte',
      'Nº do documento': '000.002', 'Emissão': '20/05/2021', 'Validade': '20/05/2025', 'Protocolo': '00.000.002-0', 'Localização': 'Fictícia'}),
]
json.dump({'type': 'FeatureCollection', 'features': feats}, open(f'data/m/{cod}/demo.geojson', 'w'), ensure_ascii=False, separators=(',', ':'))
print('ok', round(area_ha, 1), 'ha', len(feats), 'feições')
