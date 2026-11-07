#!/usr/bin/env python3
"""Recover application integration settings from checksum-pinned PUBLIC releases.

Never reads installed TV data, user accounts, add-ons, or the companion config.
Every required value must also occur in the published native 2.0.8 executable.
The resulting local.properties is ignored by Git and excluded from the IPK.
"""
import hashlib, io, json, os, pathlib, re, subprocess, tarfile, tempfile, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
ASSETS = {
    'web': ('https://github.com/iqui27/NuvioTVSmart-legacy-webos/releases/download/webos-port-1.2.0/space.nuvio.webos_1.2.0_all.ipk',
            '20ed5d0194a97608d825a1a07cac6e374709138263ca5717d571a2c15db3670e'),
    'native': ('https://github.com/iqui27/nuvio-native-legacy/releases/download/v2.0.8/space.nuvio.native.legacy_2.0.8_arm.ipk',
               'cea89bbc27940c0a966f0b972f58dddfbb8f5616a6df8a3f1efa7e9ec05ad9ce'),
}
KEYS = ('NUVIO_SUPABASE_URL', 'NUVIO_SUPABASE_ANON_KEY', 'TV_LOGIN_WEB_BASE_URL',
        'TMDB_API_KEY', 'TRAKT_CLIENT_ID', 'TRAKT_CLIENT_SECRET', 'SIMKL_CLIENT_ID', 'SIMKL_APP_NAME')

def member(package, suffix):
    payload = subprocess.check_output(['ar', 'p', str(package), 'data.tar.gz'])
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as archive:
        matches = [m for m in archive.getmembers() if m.isfile() and m.name.endswith(suffix)]
        if len(matches) != 1:
            raise SystemExit('Public release has no unique expected file')
        return archive.extractfile(matches[0]).read()

with tempfile.TemporaryDirectory(prefix='nuvio-public-build-config-') as tmp:
    files = {}
    for name, (url, digest) in ASSETS.items():
        request = urllib.request.Request(url, headers={'User-Agent': 'Nuvio-PC-Audio-build'})
        payload = urllib.request.urlopen(request, timeout=90).read()
        if hashlib.sha256(payload).hexdigest() != digest:
            raise SystemExit('Public release checksum mismatch')
        file = pathlib.Path(tmp) / (name + '.ipk')
        file.write_bytes(payload)
        files[name] = file
    env = member(files['web'], '/nuvio.env.js').decode()
    native = member(files['native'], '/nuvio-proto')
    values = {}
    for key in KEYS:
        match = re.search(r'\b' + key + r':("(?:\\.|[^"\\])*")', env)
        if not match:
            raise SystemExit('Public integration setting missing: ' + key)
        value = json.loads(match[1])
        if not value or '\n' in value or value.encode() not in native:
            raise SystemExit('Published web/native integration settings differ: ' + key)
        values[key] = value
        if os.getenv('GITHUB_ACTIONS') == 'true':
            print('::add-mask::' + value)
    output = pathlib.Path(os.environ.get('NUVIO_PROPERTIES', ROOT / 'local.properties'))
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as file:
        file.write(''.join(key + '=' + value + '\n' for key, value in values.items()))
    print('Verified public integration settings against the native 2.0.8 release; no user data used.')
