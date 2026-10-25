import json, urllib.request
def raw(u):
    try: return urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'csambiental-mapa'}), timeout=120).read().decode('utf-8','ignore')
    except Exception as e: return 'ERRO ' + str(e)
S='https://geopr.iat.pr.gov.br/server/rest/services/Hosted/service_5d013e1849744e3f8370df9b8217a741/FeatureServer'
print('SERV', raw(S + '?f=json')[:3000])
P='https://geopr.iat.pr.gov.br/portal/sharing/rest/content/items/'
for i in ['28724d644fba4b2a96645f9f421151e3','3996e939654b48228c2a5ded3b2db7ab','8cf1eaa023fa40e88549e4f727f1812f']:
    print('ITEM', i, raw(P + i + '?f=json')[:1500])
    print('DATA', i, raw(P + i + '/data?f=json')[:6000])
import re
print('HOSTED', re.findall(r'"name":"([^"]*arrag[^"]*)"[^}]*"type":"(\w+)"', raw('https://geopr.iat.pr.gov.br/server/rest/services/Hosted?f=json')))
txt = raw('https://geopr.iat.pr.gov.br/server/rest/services/Hosted?f=json'); print('HOSTED n', txt.count('"name"'))
for m in re.findall(r'"name":"(Hosted/[^"]+)","type":"FeatureServer"', txt)[:400]: print('H', m)
