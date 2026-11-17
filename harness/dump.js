// Writes one feature row per 0.25 s for every harness clip and every real negative recording -> harness/features.jsonl
const fs=require('fs'),path=require('path');const {Spotter}=require(path.resolve('core.js'));
const man=JSON.parse(fs.readFileSync(__dirname+'/manifest.json'));const out=fs.createWriteStream(__dirname+'/features.jsonl');
function feed(file,clip,labelAt,meta){const b=fs.readFileSync(file);let o=12,ch=2,sr=48000,bits=32,d;while(o<b.length){const id=b.toString('ascii',o,o+4),sz=b.readUInt32LE(o+4);if(id==='fmt '){ch=b.readUInt16LE(o+10);sr=b.readUInt32LE(o+12);bits=b.readUInt16LE(o+22);}if(id==='data'){d=b.subarray(o+8,Math.min(b.length,o+8+sz));break;}o+=8+sz+(sz&1);}
 const bs=bits/8,n=Math.floor(d.length/bs/ch),L=new Float32Array(n),R=new Float32Array(n);
 for(let i=0;i<n;i++){const a=bs===4?d.readInt32LE(i*ch*bs)/2147483648:d.readInt16LE(i*ch*bs)/32768;L[i]=a;R[i]=ch>1?(bs===4?d.readInt32LE((i*ch+1)*bs)/2147483648:d.readInt16LE((i*ch+1)*bs)/32768):a;}
 const sp=new Spotter(sr);let k=0;
 for(let i=0;i<n;i+=2400){sp.push(L.subarray(i,i+2400),R.subarray(i,i+2400));if(sp.fv&&++k%5===0)out.write(JSON.stringify({clip,t:+sp.t.toFixed(2),y:labelAt(sp.t),rumble:sp.st.rumble.on?1:0,near:sp.st.near.on?1:0,...meta,fv:sp.fv})+'\n');}}
for(const m of man){const snr=m.kind==='bed'?null:+m.name.match(/([+-]\d+)$/)[1];
 feed(__dirname+'/clips/'+m.name+'.wav',m.name,t=>m.kind==='bed'?0:(t>=m.t0+3.5&&t<=m.t1?(snr>=0?1:-1):(t<m.t0?0:-1)),{kind:m.kind,snr,voice:m.kind==='bed'?null:m.name.replace(/_(wall\d+|clear)_[+-]\d+$/,'')});}
for(const [f,c] of [['../f/st.wav','real_laptop10'],['../e/rec.wav','real_laptop2'],['../a/st.wav','real_phone0240'],['../b/rec.wav','real_phone0253'],['../c/rec.wav','real_phone0259']])feed(f,c,()=>0,{kind:'real',snr:null,voice:null});
out.end(()=>console.log('done'));
