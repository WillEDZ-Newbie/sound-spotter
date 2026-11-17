// False-alarm traps documented in the freqmon audits (C4): sounds that once scored as speech there. None may light Muffled speech or Voice in the room.
const fs=require('fs'),path=require('path');const {Spotter}=require(path.resolve(process.argv[2]||__dirname+'/../src/core.js'));
const sr=48000,secs=40,n=sr*secs;let seed=7;const rnd=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296-0.5;};
const traps={
 'steady 200 Hz whine with harmonics':i=>{const t=i/sr;return 0.02*(Math.sin(2*Math.PI*200*t)+0.5*Math.sin(2*Math.PI*400*t)+0.3*Math.sin(2*Math.PI*600*t));},
 'noise pulsing 4 times a second (pump)':i=>{const t=i/sr;return 0.02*(0.5+0.5*Math.sin(2*Math.PI*4*t))*rnd()*2;},
 'low rumble pulsing 4 times a second':(()=>{let y=0;return i=>{const t=i/sr;y+=0.01*(rnd()*2-y);return 0.6*(0.5+0.5*Math.sin(2*Math.PI*4*t))*y;};})(),
 'loud steady 1 kHz tone':i=>0.05*Math.sin(2*Math.PI*1000*i/sr),
 '120 Hz buzz switching on and off every 5 s':i=>{const t=i/sr;return (Math.floor(t/5)%2?0.02:0)*Math.sign(Math.sin(2*Math.PI*120*t));},
};
let bad=0;const model=JSON.parse(fs.readFileSync(__dirname+'/../model.json'));
for(const [name,f] of Object.entries(traps)){const sp=new Spotter(sr);sp.setSensitivity(+(process.argv[3]||1));sp.applyModel(model);const on={};const L=new Float32Array(2400),R=new Float32Array(2400);
 for(let i=0;i<n;i+=2400){for(let k=0;k<2400;k++){const v=f(i+k);L[k]=v+0.0004*rnd();R[k]=v+0.0004*rnd();}sp.push(L,R);for(const id of ['speech','voice','alarm','rhythm','pitch'])if(sp.st[id].on)on[id]=(on[id]||0)+0.05;}
 const lit=['speech','voice'].filter(id=>(on[id]||0)>=0.5);if(lit.length)bad++;
 console.log((lit.length?'FAIL ':'ok   ')+name.padEnd(44),Object.entries(on).map(([k,v])=>k+' '+v.toFixed(1)+'s').join(', ')||'nothing lit');}
process.exit(bad?1:0);
