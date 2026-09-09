import json,tempfile,unittest
from pathlib import Path
from PIL import Image
import visual_evidence as v

class VisualEvidenceTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve()
  self.cfg={'roots':{'test':str(self.root)},'max_source_bytes':32*1024*1024,'max_source_pixels':48000000,'max_preview_bytes':700000}
  Image.new('RGB',(900,1200),(180,120,140)).save(self.root/'reference.png')
  Image.new('RGB',(900,1200),(150,120,180)).save(self.root/'model.png')
 def tearDown(self):self.tmp.cleanup()
 def prepare(self,**kw):return v.prepare({'project':'test','path':'model.png',**kw},self.cfg)
 def test_prepare_is_bounded_png(self):
  r=self.prepare(max_edge=512);self.assertEqual(r['preview_size'],[384,512]);self.assertLessEqual(r['preview_bytes'],700000);self.assertEqual(r['aesthetic_verdict'],'NOT_ASSIGNED')
 def test_transparent_hidden_rgb_is_not_shown(self):
  Image.new('RGBA',(300,300),(255,0,0,0)).save(self.root/'alpha.png')
  result=v.prepare({'project':'test','path':'alpha.png'},self.cfg)
  preview=Image.open(self.root/result['preview_path'])
  self.assertEqual(preview.mode,'RGB');self.assertEqual(preview.getpixel((150,150)),(244,243,246))
 def test_original_unchanged_and_valid_crop(self):
  before=v.digest((self.root/'model.png').read_bytes());r=self.prepare(crop=[0,0,200,300]);self.assertEqual(before,v.digest((self.root/'model.png').read_bytes()));self.assertEqual(r['preview_size'],[200,300])
 def test_reject_path_traversal(self):
  for p in ('../model.png','C:/Users/test.png','/tmp/model.png','model.png:secret'):
   with self.assertRaises(v.EvidenceError):v.prepare({'project':'test','path':p},self.cfg)
 def test_missing_file(self):
  with self.assertRaises(FileNotFoundError):v.prepare({'project':'test','path':'none.png'},self.cfg)
 def test_reject_wrong_hash(self):
  with self.assertRaises(v.EvidenceError):self.prepare(expected_sha256='0'*64)
 def test_reject_invalid_crop(self):
  with self.assertRaises(v.EvidenceError):self.prepare(crop=[0,0,901,10])
 def test_corrupt_png(self):
  (self.root/'bad.png').write_bytes(b'not an image')
  with self.assertRaises(v.EvidenceError):v.prepare({'project':'test','path':'bad.png'},self.cfg)
 def test_pixel_limit(self):
  cfg={**self.cfg,'max_source_pixels':10}
  with self.assertRaises(v.EvidenceError):v.prepare({'project':'test','path':'model.png'},cfg)
 def test_overlay_rejects_mismatch(self):
  Image.new('RGB',(300,300)).save(self.root/'small.png')
  with self.assertRaises(v.EvidenceError):v.compare({'project':'test','reference':'small.png','model':'model.png','mode':'registered_overlay','registration_note':'fixed matched camera'},self.cfg)
 def test_overlay_returns_real_png_no_score(self):
  r=v.compare({'project':'test','reference':'reference.png','model':'model.png','mode':'registered_overlay','registration_note':'test identical calibrated pixel canvases'},self.cfg)
  self.assertEqual(len(r['sources']),2);self.assertEqual(r['aesthetic_verdict'],'NOT_ASSIGNED');Image.open(self.root/r['preview_path']).verify()
 def test_ack_requires_exact_preview_and_observations(self):
  r=self.prepare();args={'project':'test','id':r['id'],'observed_preview_sha256':r['preview_sha256'],'verdict':'FAIL','observations':'I inspected the actual pixels: this fixture is a single uniform rectangular region.'}
  result=v.acknowledge(args,self.cfg);self.assertEqual(result['verdict'],'FAIL')
  with self.assertRaises(v.EvidenceError):v.acknowledge({**args,'observed_preview_sha256':'0'*64},self.cfg)
 def test_stale_source_blocks_review(self):
  r=self.prepare();Image.new('RGB',(900,1200)).save(self.root/'model.png')
  with self.assertRaises(v.EvidenceError):v.acknowledge({'project':'test','id':r['id'],'observed_preview_sha256':r['preview_sha256'],'verdict':'PASS','observations':'An explicit agent observation cannot override a changed image source.'},self.cfg)
if __name__=='__main__':unittest.main(verbosity=2)
