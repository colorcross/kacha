"""Provider response/stream fixtures plus real media decoding; no credentials."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from email.message import Message
from io import BytesIO

REPO = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("stock", REPO / "scripts/fetch_stock_media.py")
stock = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stock)

class Response(BytesIO):
    def __init__(self, body, content_type="image/png", declared=None):
        super().__init__(body)
        self.headers = Message()
        self.headers["Content-Type"] = content_type
        if declared is not None: self.headers["Content-Length"] = str(declared)

class StockTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="kacha-stock-tests-")
        self.root = Path(self.temp.name)
        self.image = self.root / "source.png"
        subprocess.run([os.getenv("KACHA_FFMPEG_BIN", "ffmpeg"), "-v", "error", "-f", "lavfi", "-i",
                        "color=blue:s=32x32", "-frames:v", "1", str(self.image)], check=True)
        self.body = self.image.read_bytes()
    def tearDown(self): self.temp.cleanup()
    def item(self, n):
        return {"id":n,"download_url":f"https://media.invalid/{n}.png","fallback_suffix":".png",
                "source_url":f"https://source.invalid/{n}","creator":"fixture author",
                "dimensions":{"width":32,"height":32},"tags":"blue square"}
    def test_pixabay_orientation_uses_provider_values_and_filters_video(self):
        image = {"id":1,"largeImageURL":"https://media.invalid/1.png","imageWidth":32,"imageHeight":64}
        with patch.object(stock,"fetch_json",return_value={"hits":[image]}) as fetch:
            self.assertEqual(len(stock.pixabay_items("fixture","book","photo","portrait",1,5)),1)
            self.assertIn("orientation=vertical",fetch.call_args.args[0])
        hits = [{"id":i,"videos":{"medium":{"url":f"https://media.invalid/{i}.mp4","width":w,"height":h}}}
                for i,w,h in [(1,1920,1080),(2,720,1280),(3,100,100)]]
        with patch.object(stock,"fetch_json",return_value={"hits":hits}):
            self.assertEqual([x['id'] for x in stock.pixabay_items('fixture','x','video','portrait',3,5)],[2])
            self.assertEqual([x['id'] for x in stock.pixabay_items('fixture','x','video','square',3,5)],[3])
    def test_commons_file_license_and_bounded_video_rendition(self):
        info={'url':'https://media.invalid/original.webm','mime':'video/webm','width':3840,'height':2160,
              'descriptionurl':'https://commons.wikimedia.org/wiki/File:Fixture.webm',
              'extmetadata':{'Artist':{'value':'<b>Original author</b>'},'LicenseUrl':{'value':'https://creativecommons.org/licenses/by/4.0/'}},
              'derivatives':[{'src':f'https://media.invalid/{w}.webm','type':'video/webm; codecs=vp9','width':w,'height':h} for w,h in [(3840,2160),(1920,1080),(640,360)]]}
        with patch.object(stock,'fetch_json',return_value={'query':{'pages':{'1':{'pageid':1,'videoinfo':[info]}}}}) as fetch:
            item=stock.commons_items('book','video','landscape',1,5)[0]
            self.assertEqual(item['download_url'],'https://media.invalid/1920.webm')
            self.assertEqual(item['creator'],'Original author');self.assertIn('videoinfo',fetch.call_args.args[0])
            info['extmetadata'].pop('LicenseUrl');self.assertEqual(stock.commons_items('book','video','landscape',1,5),[])
    def test_web_selection_requires_sources_licenses_and_safe_suffixes(self):
        item=self.item(1);item['license_url']='https://example.com/license'
        file=self.root/'candidates.json';report={'schema':'kacha.network-candidates.v1','provider':'web','kind':'photo','query':'blue','items':[item]}
        file.write_text(json.dumps(report));self.assertEqual(len(stock.read_candidates(file,'web','photo','blue',['1'])),1)
        with self.assertRaises(RuntimeError):stock.read_candidates(file,'web','photo','blue',['9'])
        item['license_url']='';file.write_text(json.dumps(report))
        with self.assertRaises(RuntimeError):stock.read_candidates(file,'web','photo','blue',[])
        with self.assertRaises(RuntimeError):stock.suffix_for('https://example.com/file','/../../escape')
        with self.assertRaises(RuntimeError):stock.web_url('file:///etc/passwd')
    def test_search_cache_reuses_success_and_expires_without_storing_credentials(self):
        url='https://search.invalid/?key=fixture-private-value'
        with patch.object(stock,'config_root',return_value=self.root), patch.object(stock.urllib.request,'urlopen',side_effect=[Response(b'{"hits": []}'),Response(b'{"hits": [1]}')]) as fetch:
            self.assertEqual(stock.fetch_json(url),{'hits':[]})
            self.assertEqual(stock.fetch_json(url),{'hits':[]});self.assertEqual(fetch.call_count,1)
            cache=next((self.root/'stock-search-cache').glob('*.json'))
            self.assertNotIn('fixture-private-value',cache.read_text());self.assertNotIn('fixture-private-value',cache.name)
            value=json.loads(cache.read_text());value['retrieved_at']-=86401;cache.write_text(json.dumps(value))
            self.assertEqual(stock.fetch_json(url),{'hits':[1]});self.assertEqual(fetch.call_count,2)
    def test_pexels_renditions_bound_long_edge_and_use_smallest_large_fallback(self):
        def choose(sizes):
            files=[{"width":w,"height":h,"link":f"https://media.invalid/{h}.mp4","file_type":"video/mp4"} for w,h in sizes]
            with patch.object(stock,"fetch_json",return_value={"videos":[{"id":1,"video_files":files}]}):
                return stock.pexels_items('fixture','x','video','portrait',1,5)[0]['dimensions']
        self.assertEqual(choose([(1080,1920),(1440,2560),(2160,3840)]),{"width":1080,"height":1920})
        self.assertEqual(choose([(2160,3840),(1440,2560)]),{"width":1440,"height":2560})
    def test_download_real_decoding_and_no_clobber_at_publication(self):
        target=self.root/'download.png'
        with patch.object(stock.urllib.request,'urlopen',return_value=Response(self.body)):
            digest,_,size,decoded=stock.download('https://media.invalid/1.png',target,'photo')
        self.assertEqual(digest,hashlib.sha256(self.body).hexdigest()); self.assertEqual(size,len(self.body));self.assertEqual(decoded['width'],32)
        race=self.root/'race.png'
        def competing_writer(*args): race.write_bytes(b'other writer'); return {}
        with patch.object(stock.urllib.request,'urlopen',return_value=Response(self.body)), patch.object(stock,'validate_media',side_effect=competing_writer):
            with self.assertRaises(FileExistsError): stock.download('https://media.invalid/1.png',race,'photo')
        self.assertEqual(race.read_bytes(),b'other writer'); self.assertFalse(list(self.root.glob('*.part')))
    def test_oversize_truncated_and_invalid_media_leave_no_candidate(self):
        for name,body,declared,limit in [('large',self.body,None,4),('short',self.body,len(self.body)+5,10000),('invalid',b'not image',None,10000)]:
            target=self.root/f'{name}.png'
            with patch.object(stock.urllib.request,'urlopen',return_value=Response(body,declared=declared)):
                with self.assertRaises(RuntimeError): stock.download('https://media.invalid/x.png',target,'photo',max_bytes=limit)
            self.assertFalse(target.exists())
    def test_partial_batch_preserves_each_completed_source_and_indexes_it(self):
        destination=self.root/'downloads'
        with patch.object(stock.urllib.request,'urlopen',side_effect=[Response(self.body),OSError('offline')]):
            with self.assertRaisesRegex(RuntimeError,'preserved 1 asset'):
                stock.download_batch([self.item(1),self.item(2)],destination,provider='pixabay',kind='photo',query='blue diagram',orientation='square')
        manifest_file=next(destination.glob('manifest.*.json')); manifest=json.loads(manifest_file.read_text())
        self.assertEqual(manifest['status'],'partial');self.assertEqual(len(manifest['items']),1);self.assertEqual(len(manifest['pending']),1)
        index=self.root/'index.json'
        command=['node',str(REPO/'scripts/kacha_media.mjs'),'index','--root',str(destination),'--catalog',str(manifest_file),'--no-scan','--output',str(index)]
        result=subprocess.run(command,capture_output=True,text=True);self.assertEqual(result.returncode,0,result.stderr)
        asset=json.loads(index.read_text())['items'][0]
        self.assertEqual(asset['kind'],'image');self.assertEqual(asset['license'],stock.LICENSES['pixabay'])
        self.assertEqual(asset['provenance']['source'],'https://source.invalid/1');self.assertIn('blue diagram',asset['fields']['searchQuery'])
        self.assertIn('search_query_unreviewed',asset['semanticEvidence']);self.assertNotIn('description',asset['semanticEvidence'])
        result=subprocess.run(['node',str(REPO/'scripts/kacha_media.mjs'),'search',str(index),'--query','blue diagram'],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
        matches=json.loads(result.stdout)['results'];self.assertEqual(len(matches),1)
        self.assertEqual(matches[0]['path'],manifest['items'][0]['local_path'])
        self.assertIn('search_query_unreviewed',matches[0]['semanticEvidence'])
        Path(manifest['items'][0]['local_path']).write_bytes(b'changed')
        result=subprocess.run(command,capture_output=True,text=True);self.assertNotEqual(result.returncode,0);self.assertIn('身份已失效',result.stderr)

if __name__ == '__main__': unittest.main()
