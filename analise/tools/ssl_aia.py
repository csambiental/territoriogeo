"""Contexto SSL para servidores que não enviam a cadeia intermediária (ex.: geo.anm.gov.br).
Baixa o(s) certificado(s) intermediário(s) pelo endereço AIA do próprio certificado e verifica normalmente (sem desligar a verificação)."""
import ssl, urllib.request, urllib.parse
_cache = {}
def contexto(url):
    host = urllib.parse.urlparse(url).hostname
    if host in _cache: return _cache[host]
    ctx = ssl.create_default_context()
    try:
        from cryptography import x509
        from cryptography.x509.oid import AuthorityInformationAccessOID, ExtensionOID
        from cryptography.hazmat.primitives.serialization import Encoding
        cert = x509.load_pem_x509_certificate(ssl.get_server_certificate((host, 443)).encode())
        for _ in range(3):
            try: aia = cert.extensions.get_extension_for_oid(ExtensionOID.AUTHORITY_INFORMATION_ACCESS).value
            except Exception: break
            urls = [d.access_location.value for d in aia if d.access_method == AuthorityInformationAccessOID.CA_ISSUERS]
            if not urls: break
            der = urllib.request.urlopen(urls[0], timeout=60).read()
            try: cert = x509.load_der_x509_certificate(der)
            except Exception: cert = x509.load_pem_x509_certificate(der)
            ctx.load_verify_locations(cadata=cert.public_bytes(Encoding.PEM).decode())
            if cert.issuer == cert.subject: break
    except Exception as e:
        print('  cadeia AIA não obtida para', host, e, flush=True)
    _cache[host] = ctx
    return ctx
