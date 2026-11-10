import json, urllib.request, urllib.parse, ssl
ctx = ssl.create_default_context(); ctx.set_ciphers('DEFAULT@SECLEVEL=0'); ctx.options |= 0x4
def get(u, **q):
    q.setdefault('f','json'); u=u+('&' if '?' in u else '?')+urllib.parse.urlencode(q)
    return json.load(urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'csambiental'}),timeout=90,context=ctx))
it='8822b609fde740ad8c26d024404ac0ac'
for base in ['https://geopr.iat.pr.gov.br/portal/sharing/rest/content/items/'+it]:
    try: d=get(base); print(json.dumps({k:d.get(k) for k in ('title','type','url','snippet','description','tags')},ensure_ascii=False)[:2500])
    except Exception as e: print('ERRO',e)
    try: d=get(base+'/data'); print('DATA',json.dumps(d,ensure_ascii=False)[:3000])
    except Exception as e: print('ERRO data',e)
# serviços com licen no nome
def varrer(raiz, prof=0):
    try: d=get(raiz)
    except Exception as e: print('ERRO',raiz,e); return
    for s in d.get('services',[]):
        if any(k in s['name'].lower() for k in ['licen','sga','empreend','atividade']):
            u=f"{raiz.split('/rest/services')[0]}/rest/services/{s['name']}/{s['type']}"
            try:
                m=get(u)
                for l in m.get('layers',[]):
                    lm=get(f"{u}/{l['id']}"); n=get(f"{u}/{l['id']}/query",where='1=1',returnCountOnly='true').get('count')
                    print('LAYER',f"{u}/{l['id']}",l['name'],n,[f['name'] for f in lm.get('fields',[])][:60])
                    s1=get(f"{u}/{l['id']}/query",where='1=1',outFields='*',resultRecordCount=2,returnGeometry='false')
                    for ft in s1.get('features',[]): print('  ex',json.dumps(ft['attributes'],ensure_ascii=False)[:1500])
            except Exception as e: print('ERRO svc',u,e)
    if prof<1:
        for f in d.get('folders',[]): varrer(raiz.rstrip('/')+'/'+f,prof+1)
varrer('https://geopr.iat.pr.gov.br/server/rest/services')
