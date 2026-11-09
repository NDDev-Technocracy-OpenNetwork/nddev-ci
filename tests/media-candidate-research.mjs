import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { openSync, closeSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, chmodSync, statSync, rmSync } from "node:fs";
import path from "node:path";

const root = mkdtempSync(path.join(process.env.RUNNER_TEMP, "media-feature-probe-"));
const prefix = "ffmpeg-n9.0.2-39-g7adfbe40dc-linux64-gpl-9.0";
const archive = path.join(process.env.RUNNER_TEMP, "media-candidate-assets/ffmpeg-candidate.tar.xz");
const receipt = {schema_version:1, research_only:true, source:{repository:"FFmpeg-Builds/FFmpeg-Builds",tag:"autobuild-2026-10-31-12-59",asset:695398184,sha256:"73e29a56974ae5a651133a04584c7483b21afe941e17dc91d79814a758b608d3"}, binaries:{}, cases:[]};
function command(program, args, input) {
  const result=spawnSync(program,args,{input,encoding: input===undefined ? "utf8" : undefined,timeout:60000,maxBuffer:2*1024*1024});
  if(result.error || result.status!==0) throw Error(`Media probe command failed: ${path.basename(program)} ${result.status}: ${String(result.stderr).slice(-1500)}`);
  return result.stdout;
}
function check(condition, message) { if(!condition) throw Error(message); }
try {
  const bin=path.join(root,"bin"); mkdirSync(bin);
  for(const name of ["ffmpeg","ffprobe"]) {
    const member=`${prefix}/bin/${name}`;
    const listing=command("tar",["-tvJf",archive,"--",member]).trim().split("\n");
    check(listing.length===1 && listing[0].startsWith("-"),"Only one regular native member is accepted");
    const declared=Number(listing[0].trim().split(/\s+/)[2]);
    check(Number.isSafeInteger(declared)&&declared>0&&declared<=256*1024*1024,"Native member exceeds its bound");
    const binary=path.join(bin,name), output=openSync(binary,"wx",0o600);
    let extraction;
    try { extraction=spawnSync("tar",["-xOJf",archive,"--",member],{stdio:["ignore",output,"pipe"],timeout:60000,maxBuffer:65536}); }
    finally { closeSync(output); }
    check(!extraction.error && extraction.status===0 && statSync(binary).size===declared,"Extracted native member differs from its metadata");
    chmodSync(binary,0o555);
    receipt.binaries[name]={bytes:declared,sha256:createHash("sha256").update(readFileSync(binary)).digest("hex"),version:command(binary,["-version"]).split("\n")[0]};
  }
  const ffmpeg=path.join(bin,"ffmpeg"), ffprobe=path.join(bin,"ffprobe");
  const run=(args,input)=>command(ffmpeg,["-hide_banner","-loglevel","error","-y",...args],input);
  const probe=file=>JSON.parse(command(ffprobe,["-v","error","-show_streams","-show_format","-of","json",file]));
  receipt.build=command(ffmpeg,["-buildconf"]);
  const encoders=command(ffmpeg,["-hide_banner","-encoders"]), filters=command(ffmpeg,["-hide_banner","-filters"]);
  for(const name of ["libx264","aac","libvpx","libopus","mjpeg","png","libwebp"]) check(encoders.includes(name),`Missing encoder ${name}`);
  for(const name of ["scale","pad","format","setsar","trim","setpts","concat"]) check(new RegExp(`\\s${name}\\s`).test(filters),`Missing filter ${name}`);
  const ppm=path.join(root,"frame.ppm"), jpeg=path.join(root,"frame.jpg"), tone=path.join(root,"audio.pcm");
  const pixels=Buffer.alloc(160*120*3); for(let i=0;i<pixels.length;i+=3)pixels[i]=255;
  writeFileSync(ppm,Buffer.concat([Buffer.from("P6\n160 120\n255\n"),pixels]));
  run(["-i",ppm,"-frames:v","1",jpeg]);
  const pcm=Buffer.alloc(48000*2*2);
  for(let i=0;i<48000;i++){ const sample=Math.round(12000*Math.sin(2*Math.PI*440*i/48000));pcm.writeInt16LE(sample,i*4);pcm.writeInt16LE(sample,i*4+2); }
  writeFileSync(tone,pcm);
  const input=Buffer.concat(Array.from({length:10},()=>readFileSync(jpeg)));
  for(const [extension,video,audio] of [["mp4","libx264","aac"],["mov","libx264","aac"],["mkv","libx264","aac"],["webm","libvpx","libopus"]]) {
    const output=path.join(root,`capture.${extension}`);
    run(["-f","image2pipe","-framerate","10","-vcodec","mjpeg","-i","pipe:0","-f","s16le","-ar","48000","-ac","2","-i",tone,"-t","1","-vf","scale=80:80:force_original_aspect_ratio=decrease,pad=80:80:(ow-iw)/2:(oh-ih)/2,format=yuv420p,setsar=1","-c:v",video,"-c:a",audio,output],input);
    const info=probe(output), v=info.streams.find(s=>s.codec_type==="video"), a=info.streams.find(s=>s.codec_type==="audio");
    check(v?.width===80&&v?.height===80&&v.codec_name===(extension==="webm"?"vp8":"h264"),"Video format/dimensions differ");
    check(a?.codec_name===(extension==="webm"?"opus":"aac")&&a.channels===2,"Audio format/channels differ");
    const decoded=command(ffmpeg,["-v","error","-i",output,"-frames:v","1","-f","rawvideo","-pix_fmt","rgb24","pipe:1"],Buffer.alloc(0));
    check(decoded.length===80*80*3&&decoded[0]<12&&decoded[1]<12&&decoded[2]<12,"Padding is not black");
    const center=(40*80+40)*3;check(decoded[center]>200&&decoded[center+1]<40&&decoded[center+2]<40,"Decoded fixture color differs");
    receipt.cases.push({case:`jpeg-pcm-${extension}`,video:v.codec_name,audio:a.codec_name,width:v.width,height:v.height,duration:Number(info.format.duration),bytes:statSync(output).size});
  }
  for(const extension of ["png","webp"]) {
    const output=path.join(root,`resize.${extension}`);run(["-i",jpeg,"-vf","scale=80:-1","-frames:v","1",output]);
    const v=probe(output).streams[0];check(v.width===80&&v.height===60,"Resize dimensions differ");
    receipt.cases.push({case:`resize-${extension}`,width:v.width,height:v.height});
  }
  const demo=path.join(root,"demo.mp4");
  run(["-i",path.join(root,"capture.mp4"),"-filter_complex","[0:v]trim=start=0.1:end=0.3,setpts=PTS-STARTPTS[a];[0:v]trim=start=0.5:end=0.8,setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1:a=0[out]","-map","[out]","-c:v","libx264",demo]);
  const duration=Number(probe(demo).format.duration);check(duration>=0.4&&duration<=0.7,"Demo cut duration differs");
  receipt.cases.push({case:"demo-trim-concat",duration});
  const malformed=spawnSync(ffmpeg,["-v","error","-f","image2pipe","-vcodec","mjpeg","-i","pipe:0","-c:v","libx264",path.join(root,"invalid.mp4")],{input:Buffer.from("invalid JPEG"),timeout:10000,maxBuffer:65536});
  check(!malformed.error&&malformed.status!==0,"Malformed image was accepted or decoder did not finish");
  receipt.cases.push({case:"malformed-image-refused",status:malformed.status});
  receipt.complete=true;console.log(JSON.stringify(receipt));
} finally { rmSync(root,{recursive:true,force:true}); }
