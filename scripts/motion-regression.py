"""Compatibility entry point for the current logo/entrance overlap regression.

The previous linear/shared-text and behind-title motion policies were replaced.
All checks now use the real scene choreography and include adversarial long copy.
"""
import argparse, os, subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser()
parser.add_argument('--scope',choices=['all','bugs','smoke','painting'],default='all')
parser.add_argument('--output',type=Path,default=ROOT/'test-results'/'motion-regression')
args=parser.parse_args()
env=os.environ.copy();env['BROADCAST_TEST_OUTPUT']=str(args.output)
env['TRANSITION_LONG_CONTENT']='1'
if args.scope!='all':env['TRANSITION_CHECK_MODE']='smoke'
subprocess.run(['python3',str(ROOT/'test/transition-choreography.py')],cwd=ROOT,env=env,check=True)
