// Scores the detector on the harness clips: was each voice caught, as the right kind, and what fired on beds with no voice in them?
const fs=require('fs'),path=require('path');const {Spotter}=require(path.resolve(process.argv[2]||'core.js'));const sens=+(process.argv[3]||1);
const man=JSON.parse(fs.readFileSync(__dirname+'/manifest.json'));
function run(name){const b=fs.readFileSync(__dirname+'/clips/'+name+'.wav');const sr=b.readUInt32LE(24),d=b.subarray(44),n=d.length/8,L=new Float32Array(n),R=new Float32Array(n);
 for(let i=0;i<n;i++){L[i]=d.readInt32LE(i*8)/2147483648;R[i]=d.readInt32LE(i*8+4)/2147483648;}
 const sp=new Spotter(sr);sp.setSensitivity(sens);if(process.env.MODEL)sp.applyModel(JSON.parse(fs.readFileSync(process.env.MODEL)));const on={},first={};
 const sil=process.env.SILERO?JSON.parse(fs.readFileSync(__dirname+'/silero/'+name+'.json')):null;if(sil)sp.sileroOn=true;
 for(let i=0;i<n;i+=2400){if(sil){const k=Math.floor(i/sr*31.25);if(k<sil.length){sp.silero=sil[k];sp.sileroAt=i/sr;}}sp.push(L.subarray(i,i+2400),R.subarray(i,i+2400));for(const id of ['speech','voice','alarm','rumble','near','rhythm','pitch'])if(sp.st[id].on){on[id]=(on[id]||0)+0.05;if(first[id]===undefined)first[id]=sp.t;}}
 return {on,first};}
const tab={},fa={};let rows=[];
for(const m of man){const r=run(m.name);const sec=id=>+(r.on[id]||0).toFixed(1);
 if(m.kind==='bed'){const f=['speech','voice','alarm'].filter(id=>sec(id)>0).map(id=>id+' '+sec(id)+'s');fa[m.name]=f.join(', ')||'-';continue;}
 const snr=m.name.match(/([+-]\d+)$/)[1],key=m.kind+' '+snr;tab[key]=tab[key]||{n:0,right:0,other:0,miss:0,delay:[]};const t=tab[key];t.n++;
 const want=m.expect,alt=want==='speech'?'voice':'speech';
 if(sec(want)>=1){t.right++;t.delay.push(r.first[want]-m.t0);}else if(sec(alt)>=1)t.other++;else t.miss++;
 rows.push(`${m.name}: speech ${sec('speech')}s voice ${sec('voice')}s rhythm ${sec('rhythm')}s pitch ${sec('pitch')}s`);}
console.log('condition      caught-as-expected  caught-as-other-kind  missed  median-delay');
for(const k of Object.keys(tab)){const t=tab[k];t.delay.sort((a,b)=>a-b);console.log(k.padEnd(14),`${t.right}/${t.n}`.padEnd(19),String(t.other).padEnd(21),String(t.miss).padEnd(7),t.delay.length?t.delay[t.delay.length>>1].toFixed(1)+'s':'-');}
console.log('\nbeds with no target voice (babble and neighbor do contain voices):');for(const k in fa)console.log(' ',k.padEnd(32),fa[k]);
if(process.argv[4])console.log('\n'+rows.join('\n'));
