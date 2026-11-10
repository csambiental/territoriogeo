import json, urllib.request, urllib.parse, ssl
ctx = ssl.create_default_context(); ctx.set_ciphers('DEFAULT@SECLEVEL=0'); ctx.options |= 0x4
def get(u, **q):
    q.setdefault('f','json'); return json.load(urllib.request.urlopen(urllib.request.Request(u+'?'+urllib.parse.urlencode(q),headers={'User-Agent':'csambiental'}),timeout=120,context=ctx))
for u in ['https://geopr.iat.pr.gov.br/server/rest/services/00_PUBLICACOES/outorgas_sigarh/FeatureServer/0','https://geopr.iat.pr.gov.br/server/rest/services/00_PUBLICACOES/licenciamento_ambiental_pr/FeatureServer/0']:
    m=get(u); print('##',u,m.get('maxRecordCount'),[f['name'] for f in m['fields']])
    print(' total', get(u+'/query',where='1=1',returnCountOnly='true'))
    for g in ['st_portaria','sigla_modalidade']:
        if any(f['name']==g for f in m['fields']):
            d=get(u+'/query',where='1=1',groupByFieldsForStatistics=g,outStatistics=json.dumps([{'statisticType':'count','onStatisticField':'objectid','outStatisticFieldName':'n'}]))
            print(' ',g,sorted([(x['attributes'][g],x['attributes']['n']) for x in d['features']],key=lambda t:-t[1])[:25])
    print(' ex', json.dumps(get(u+'/query',where='1=1',outFields='*',resultRecordCount=1,returnGeometry='false')['features'][0]['attributes'],ensure_ascii=False)[:1200].replace('cpf','X'))
