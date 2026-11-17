(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  const maskCanvas = document.createElement('canvas');
  const maskCtx = maskCanvas.getContext('2d', {willReadFrequently:true});
  const textureCanvas = document.createElement('canvas');
  const textureCtx = textureCanvas.getContext('2d');
  const warpedCanvas = document.createElement('canvas');
  const warpedCtx = warpedCanvas.getContext('2d');
  const compositeCanvas = document.createElement('canvas');
  const compositeCtx = compositeCanvas.getContext('2d');

  const state = {
    photo: null,
    texture: null,
    textureName: '',
    corners: [],
    mode: 'corners',
    dragging: -1,
    drawing: false,
    showBefore: false,
    maskDirty: false,
    history: [],
    renderQueued: false,
    aiBusy: false
  };


  const textureDefinitions = [
    ['pedra', 'Pedra clara', drawStone],
    ['cimento', 'Cimento', drawCement],
    ['tijolo', 'Tijolinho', drawBrick],
    ['porcelanato', 'Porcelanato', drawPorcelain]
  ];

  const textureImages = new Map();
  textureDefinitions.forEach(([id, name, painter], index) => {
    const tile = document.createElement('canvas');
    tile.width = tile.height = 256;
    painter(tile.getContext('2d'), 256);
    textureImages.set(id, tile);
    const button = document.createElement('button');
    button.className = 'texture-option';
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(index === 0));
    button.dataset.texture = id;
    button.append(tile.cloneNode(true));
    button.querySelector('canvas').getContext('2d').drawImage(tile, 0, 0);
    const label = document.createElement('span');
    label.textContent = name;
    button.append(label);
    button.addEventListener('click', () => selectTexture(id, name));
    $('textureList').append(button);
  });
  state.texture = textureImages.get('pedra');
  state.textureName = 'Pedra clara';

  function seededNoise(x, y, seed = 1) {
    const value = Math.sin(x * 12.9898 + y * 78.233 + seed * 35.17) * 43758.5453;
    return value - Math.floor(value);
  }

  function drawStone(c, size) {
    c.fillStyle = '#d7d1c4'; c.fillRect(0,0,size,size);
    const cells = 7, w = size / cells;
    for(let y=0;y<cells;y++) for(let x=0;x<cells;x++) {
      const jx=(seededNoise(x,y,2)-.5)*10, jy=(seededNoise(x,y,3)-.5)*10;
      c.fillStyle = `hsl(39 15% ${68 + seededNoise(x,y,4)*16}%)`;
      c.beginPath();
      c.roundRect(x*w+3+jx, y*w+3+jy, w-7, w-7, 9);
      c.fill();
      c.strokeStyle='#b9b2a5'; c.lineWidth=2; c.stroke();
    }
  }
  function drawCement(c, size) {
    c.fillStyle='#aaa9a5'; c.fillRect(0,0,size,size);
    const image=c.getImageData(0,0,size,size);
    for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
      const i=(y*size+x)*4, n=(seededNoise(x,y,8)-.5)*24;
      image.data[i]+=n; image.data[i+1]+=n; image.data[i+2]+=n;
    }
    c.putImageData(image,0,0);
    const g=c.createRadialGradient(80,70,5,110,120,190);g.addColorStop(0,'#ffffff1e');g.addColorStop(1,'#00000020');c.fillStyle=g;c.fillRect(0,0,size,size);
  }
  function drawBrick(c, size) {
    c.fillStyle='#d7c9b5';c.fillRect(0,0,size,size);
    const h=48,w=92;
    for(let row=-1;row<7;row++) for(let col=-1;col<5;col++) {
      const x=col*w+(row%2?w/2:0),y=row*h;
      const light=48+seededNoise(col,row,6)*14;
      c.fillStyle=`hsl(15 38% ${light}%)`;c.fillRect(x+3,y+3,w-6,h-6);
      c.fillStyle='#ffffff12';c.fillRect(x+6,y+6,w-12,5);
    }
  }
  function drawPorcelain(c, size) {
    c.fillStyle='#e4e2dc';c.fillRect(0,0,size,size);
    c.strokeStyle='#aaa7a0';c.lineWidth=5;c.strokeRect(2.5,2.5,size-5,size-5);
    c.strokeStyle='#c4c1bb';c.lineWidth=2;
    for(let i=0;i<7;i++){c.beginPath();c.moveTo(-30,i*44+seededNoise(i,2,7)*25);c.bezierCurveTo(60,i*31,150,i*55,290,i*38);c.stroke()}
  }

  function selectTexture(id, name) {
    state.texture = textureImages.get(id);
    state.textureName = name;
    document.querySelectorAll('.texture-option').forEach(b => b.setAttribute('aria-checked', String(b.dataset.texture === id)));
    scheduleRender();
    setStatus(`Textura “${name}” selecionada.`);
  }

  // Grow only the connected surface around the click, following gradual lighting changes.
  function surfaceMask(rgb, width, height, seed) {
    const selected = new Uint8Array(width * height);
    const queue = new Int32Array(selected.length);
    let head = 0, tail = 1;
    selected[seed] = 1;
    queue[0] = seed;
    const seedRG = rgb[4*seed] - rgb[4*seed+1];
    const seedGB = rgb[4*seed+1] - rgb[4*seed+2];
    // Long horizontal edges often separate a wall, baseboard and floor.
    const boundary = new Uint8Array(height);
    for (let y = 1; y < height; y++) {
      let edges = 0;
      for (let x = 0; x < width; x++) {
        const i = 4*(y*width+x);
        if (Math.abs(rgb[i+1]-rgb[i-4*width+1]) > 9) edges++;
      }
      boundary[y] = edges > width * 0.48;
    }
    function visit(from, to) {
      if (selected[to]) return;
      const i = to*4, j = from*4;
      const r = rgb[i], g = rgb[i+1], b = rgb[i+2];
      if (Math.abs(r-g-seedRG)>17 || Math.abs(g-b-seedGB)>17) return;
      if (Math.max(Math.abs(r-rgb[j]),Math.abs(g-rgb[j+1]),Math.abs(b-rgb[j+2]))>17) return;
      selected[to] = 1;
      queue[tail++] = to;
    }
    while (head < tail) {
      const p = queue[head++], x = p % width, y = Math.floor(p/width);
      if (x) visit(p,p-1);
      if (x+1<width) visit(p,p+1);
      if (y && !boundary[y]) visit(p,p-width);
      if (y+1<height && !boundary[y+1]) visit(p,p+width);
    }
    return selected;
  }

  // Fill enclosed gaps left by flaking plaster. Keep exterior gaps and large openings.
  function fillPlasterGaps(mask, width, height) {
    const seen = new Uint8Array(mask.length);
    const queue = new Int32Array(mask.length);
    const limit = Math.round(mask.length * 0.045);
    for (let start = 0; start < mask.length; start++) {
      if (mask[start] || seen[start]) continue;
      let count = 1, exterior = false;
      queue[0] = start;
      seen[start] = 1;
      function visit(index) {
        if (seen[index] || mask[index]) return;
        seen[index] = 1;
        queue[count++] = index;
      }
      for (let i = 0; i < count; i++) {
        const index = queue[i], x = index % width, y = Math.floor(index / width);
        if (!x || !y || x === width-1 || y === height-1) exterior = true;
        if (x) visit(index-1);
        if (x+1 < width) visit(index+1);
        if (y) visit(index-width);
        if (y+1 < height) visit(index+width);
      }
      if (!exterior && count <= limit) {
        for (let i = 0; i < count; i++) mask[queue[i]] = 1;
      }
    }
  }

  function enableIdentifyMode() {
    if (!state.photo) { setStatus('Envie uma foto para identificar a superfície.'); return; }
    setMode('identify');
    state.showBefore = false;
    $('beforeBtn').textContent = 'Antes/depois';
  }

  function runAISelection(point) {
    const sample = document.createElement('canvas');
    const ratio = Math.min(1, 640/Math.max(canvas.width,canvas.height));
    const w = sample.width = Math.max(1,Math.round(canvas.width*ratio));
    const h = sample.height = Math.max(1,Math.round(canvas.height*ratio));
    const context = sample.getContext('2d');
    context.drawImage(state.photo,0,0,w,h);
    const pixels = context.getImageData(0,0,w,h);
    const x = Math.max(0,Math.min(w-1,Math.floor(point.x*w/canvas.width)));
    const y = Math.max(0,Math.min(h-1,Math.floor(point.y*h/canvas.height)));
    const mask = surfaceMask(pixels.data,w,h,y*w+x);
    if ($('fillGaps').checked) fillPlasterGaps(mask,w,h);
    let left=w, top=h, right=0, bottom=0, count=0;
    for (let i=0; i<mask.length; i++) {
      pixels.data[4*i+3] = mask[i]*255;
      if (!mask[i]) continue;
      count++;
      const col=i%w, row=Math.floor(i/w);
      left=Math.min(left,col); right=Math.max(right,col+1);
      top=Math.min(top,row); bottom=Math.max(bottom,row+1);
    }
    if (count < w*h*0.002) {
      setStatus('A seleção ficou pequena. Clique em uma parte mais uniforme da superfície.');
      return;
    }
    pushHistory();
    context.putImageData(pixels,0,0);
    maskCtx.clearRect(0,0,canvas.width,canvas.height);
    maskCtx.drawImage(sample,0,0,canvas.width,canvas.height);
    state.corners=[[left,top],[right,top],[right,bottom],[left,bottom]].map(([cx,cy])=>({x:cx*canvas.width/w,y:cy*canvas.height/h}));
    state.maskDirty=true;
    scheduleRender();
    setStatus('Textura aplicada. Clique em outra superfície para trocar a seleção ou use a borracha para corrigir.');
  }

  function setStatus(message) { $('status').textContent = message; }

  function resizeWorkCanvases(width, height) {
    [canvas, maskCanvas, warpedCanvas, compositeCanvas].forEach(c => { c.width=width; c.height=height; });
    textureCanvas.width = textureCanvas.height = 1024;
  }

  function loadFile(file, callback) {
    if (!file || !/^image\/(jpeg|png|webp)$/.test(file.type)) {
      setStatus('Escolha uma imagem JPG, PNG ou WEBP.'); return;
    }
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => { URL.revokeObjectURL(url); callback(image); };
    image.onerror = () => { URL.revokeObjectURL(url); setStatus('Não foi possível abrir essa imagem.'); };
    image.src = url;
  }

  function setPhoto(image) {
    const max = 1800, ratio = Math.min(1, max / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.round(image.naturalWidth * ratio), height = Math.round(image.naturalHeight * ratio);
    const normalized = document.createElement('canvas'); normalized.width=width; normalized.height=height;
    normalized.getContext('2d').drawImage(image,0,0,width,height);
    state.photo = normalized;
    resizeWorkCanvases(width,height);
    state.corners = [
      {x:width*.18,y:height*.18},{x:width*.82,y:height*.18},
      {x:width*.88,y:height*.82},{x:width*.12,y:height*.82}
    ];
    state.history=[]; state.maskDirty=false; state.showBefore=false;
    maskCtx.clearRect(0,0,width,height);
    setMode('identify');
    $('emptyState').hidden=true;
    ['beforeBtn','resetBtn','downloadBtn'].forEach(id => $(id).disabled=false);
    updateUndo(); fitCanvas(); scheduleRender();
    setStatus('Clique na parede ou no piso para aplicar a textura.');
  }

  function resetMaskToPolygon() {
    if(!state.photo) return;
    maskCtx.clearRect(0,0,maskCanvas.width,maskCanvas.height);
    maskCtx.fillStyle='#fff'; maskCtx.beginPath();
    state.corners.forEach((p,i)=>i?maskCtx.lineTo(p.x,p.y):maskCtx.moveTo(p.x,p.y));
    maskCtx.closePath(); maskCtx.fill(); state.maskDirty=false;
  }

  function pushHistory() {
    if(!state.photo) return;
    state.history.push({mask:maskCtx.getImageData(0,0,maskCanvas.width,maskCanvas.height),corners:state.corners.map(p=>({...p}))});
    if(state.history.length>12) state.history.shift(); updateUndo();
  }
  function undo() {
    const item=state.history.pop(); if(!item)return;
    state.corners=item.corners; maskCtx.putImageData(item.mask,0,0); state.maskDirty=true; updateUndo(); scheduleRender(); setStatus('Última alteração desfeita.');
  }
  function updateUndo(){ $('undoBtn').disabled=!state.history.length; }

  function prepareTexture() {
    const cols = Number($('cols').value), rows = Number($('rows').value);
    const [a,b,c,d] = state.corners;
    const length = (p,q) => Math.hypot(p.x-q.x,p.y-q.y);
    const width = Math.max(1,(length(a,b)+length(d,c))/(2*cols));
    const height = Math.max(1,(length(a,d)+length(b,c))/(2*rows));
    const size = textureCanvas.width;
    const tile = document.createElement('canvas');
    tile.width = Math.ceil(size/cols);
    tile.height = Math.ceil(size/rows);
    const brush = tile.getContext('2d');
    const angle = Number($('rotation').value)*Math.PI/180;
    const cos=Math.abs(Math.cos(angle)), sin=Math.abs(Math.sin(angle));
    const sample=state.texture;
    const cover=Math.max((width*cos+height*sin)/sample.width,(height*cos+width*sin)/sample.height);
    const zoom=cover*Number($('scale').value)/120;
    brush.scale(tile.width/width,tile.height/height);
    brush.translate(width/2,height/2);
    brush.rotate(angle);
    brush.scale(zoom,zoom);
    brush.drawImage(sample,-sample.width/2,-sample.height/2);
    textureCtx.save();
    textureCtx.clearRect(0,0,size,size);
    textureCtx.scale(size/(cols*tile.width),size/(rows*tile.height));
    textureCtx.fillStyle=textureCtx.createPattern(tile,'repeat');
    textureCtx.fillRect(0,0,cols*tile.width,rows*tile.height);
    textureCtx.restore();
    const joint=Number($('joint').value);
    if (!joint) return;
    textureCtx.fillStyle='#a59e94';
    const gx=Math.min(size/cols*.15,joint*size/(cols*width));
    const gy=Math.min(size/rows*.15,joint*size/(rows*height));
    for(let i=1;i<cols;i++) textureCtx.fillRect(size*i/cols-gx/2,0,gx,size);
    for(let i=1;i<rows;i++) textureCtx.fillRect(0,size*i/rows-gy/2,size,gy);
  }

  // Read the texture along each scanline using one inverse projective map.
  function projectSurface(corners, source, output) {
    const [a,b,c,d] = corners;
    // Each pair of opposing edge equations gives one projective coordinate.
    function edge(p,q) {
      return [p.y-q.y,q.x-p.x,p.x*q.y-q.x*p.y];
    }
    const value = (line,p) => line[0]*p.x + line[1]*p.y + line[2];
    const left=edge(d,a), right=edge(b,c), top=edge(a,b), bottom=edge(c,d);
    const lu=value(left,b), ru=value(right,a), tv=value(top,d), bv=value(bottom,a);
    if ([lu,ru,tv,bv].some(v=>Math.abs(v)<1e-6)) return;
    // Normalize opposing lines at the midpoints of the mapped diagonals.
    const diag=edge(a,c), other=edge(b,d);
    const det=diag[0]*other[1]-other[0]*diag[1];
    if (Math.abs(det)<1e-6) return;
    const mid={x:(diag[1]*other[2]-other[1]*diag[2])/det,
               y:(diag[2]*other[0]-other[2]*diag[0])/det};
    for (const line of [left,right,top,bottom]) {
      const scale=value(line,mid);
      if(Math.abs(scale)<1e-8) return;
      for(let i=0;i<3;i++) line[i]/=scale;
    }
    const x0=Math.max(0,Math.floor(Math.min(...corners.map(p=>p.x))));
    const x1=Math.min(output.width,Math.ceil(Math.max(...corners.map(p=>p.x))));
    const y0=Math.max(0,Math.floor(Math.min(...corners.map(p=>p.y))));
    const y1=Math.min(output.height,Math.ceil(Math.max(...corners.map(p=>p.y))));
    const sw=source.width, sh=source.height, src=source.data, dst=output.data;
    for(let y=y0;y<y1;y++) {
      const start={x:x0+.5,y:y+.5};
      let l=value(left,start), r=value(right,start), t=value(top,start), k=value(bottom,start);
      for(let x=x0;x<x1;x++,l+=left[0],r+=right[0],t+=top[0],k+=bottom[0]) {
        if(Math.min(l,r,t,k)<0) continue;
        const u=Math.max(0,Math.min(sw-1,sw*l/(l+r)-.5));
        const v=Math.max(0,Math.min(sh-1,sh*t/(t+k)-.5));
        const ix=Math.floor(u), iy=Math.floor(v), fx=u-ix, fy=v-iy;
        const p=4*(iy*sw+ix), dx=ix+1<sw?4:0, dy=iy+1<sh?4*sw:0;
        const dest=4*(y*output.width+x);
        for(let ch=0;ch<4;ch++) {
          const pos=p+ch;
          dst[dest+ch]=(1-fy)*((1-fx)*src[pos]+fx*src[pos+dx])
                      + fy*((1-fx)*src[pos+dy]+fx*src[pos+dy+dx]);
        }
      }
    }
  }

  let projectionCache;
  function warpTexture() {
    const key=JSON.stringify([state.corners,$('cols').value,$('rows').value,$('joint').value,canvas.width,canvas.height,$('scale').value,$('rotation').value]);
    if(projectionCache?.key!==key || projectionCache.texture!==state.texture) {
      prepareTexture();
      const source=textureCtx.getImageData(0,0,textureCanvas.width,textureCanvas.height);
      const output=warpedCtx.createImageData(canvas.width,canvas.height);
      projectSurface(state.corners,source,output);
      projectionCache={key,texture:state.texture,output};
    }
    warpedCtx.putImageData(projectionCache.output,0,0);
    warpedCtx.globalCompositeOperation='destination-in';warpedCtx.drawImage(maskCanvas,0,0);warpedCtx.globalCompositeOperation='source-over';
  }

  function render() {
    state.renderQueued=false;
    ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,canvas.width,canvas.height);
    if(!state.photo){ctx.fillStyle='#292929';ctx.fillRect(0,0,canvas.width,canvas.height);return}
    ctx.drawImage(state.photo,0,0);
    if(!state.showBefore) {
      warpTexture();
      const opacity=+$('opacity').value/100, shadow=+$('shadow').value/100;
      compositeCtx.clearRect(0,0,compositeCanvas.width,compositeCanvas.height);
      compositeCtx.save();compositeCtx.filter='grayscale(1)';compositeCtx.drawImage(state.photo,0,0);compositeCtx.filter='none';compositeCtx.globalCompositeOperation='destination-in';compositeCtx.drawImage(maskCanvas,0,0);compositeCtx.restore();
      ctx.save();ctx.globalAlpha=opacity;ctx.drawImage(warpedCanvas,0,0);ctx.globalCompositeOperation='multiply';ctx.globalAlpha=shadow;ctx.drawImage(compositeCanvas,0,0);ctx.restore();
    }
    if(state.mode==='corners'&&!state.showBefore) drawGuides();
  }
  function scheduleRender(){if(!state.renderQueued){state.renderQueued=true;requestAnimationFrame(render)}}

  function drawGuides() {
    ctx.save();ctx.lineWidth=Math.max(2,canvas.width/600);ctx.setLineDash([12,9]);ctx.strokeStyle='#f2d216';ctx.fillStyle='#f2d216';ctx.beginPath();
    state.corners.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.stroke();ctx.setLineDash([]);
    const r=Math.max(11,canvas.width/75);
    state.corners.forEach((p,i)=>{ctx.beginPath();ctx.arc(p.x,p.y,r,0,Math.PI*2);ctx.fill();ctx.lineWidth=3;ctx.strokeStyle='#231f20';ctx.stroke();ctx.fillStyle='#231f20';ctx.font=`700 ${Math.max(11,r)}px Barlow`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(String(i+1),p.x,p.y+1);ctx.fillStyle='#f2d216'});ctx.restore();
  }

  function pointerPosition(event) {
    const r=canvas.getBoundingClientRect();return{x:(event.clientX-r.left)*canvas.width/r.width,y:(event.clientY-r.top)*canvas.height/r.height};
  }
  function nearestCorner(p) {
    let best=-1,dist=Infinity;state.corners.forEach((c,i)=>{const d=Math.hypot(p.x-c.x,p.y-c.y);if(d<dist){best=i;dist=d}});return dist<Math.max(36,canvas.width/18)?best:-1;
  }
  function paintMask(p) {
    const radius=+$('brushSize').value*canvas.width/900;
    maskCtx.save();maskCtx.beginPath();maskCtx.arc(p.x,p.y,radius,0,Math.PI*2);
    if(state.mode==='eraser'){maskCtx.globalCompositeOperation='destination-out';maskCtx.fillStyle='#000'}else{maskCtx.globalCompositeOperation='source-over';maskCtx.fillStyle='#fff'}
    maskCtx.fill();maskCtx.restore();state.maskDirty=true;scheduleRender();
  }
  canvas.addEventListener('pointerdown',e=>{
    if(!state.photo||state.showBefore)return;const p=pointerPosition(e);canvas.setPointerCapture(e.pointerId);
    if(state.mode==='identify'){runAISelection(p);return}
    if(state.mode==='corners'){const i=nearestCorner(p);if(i>=0){pushHistory();state.dragging=i}}
    else{pushHistory();state.drawing=true;paintMask(p)}
  });
  canvas.addEventListener('pointermove',e=>{
    if(!state.photo)return;const p=pointerPosition(e);
    if(state.dragging>=0){state.corners[state.dragging]=p;resetMaskToPolygon();scheduleRender()}
    if(state.drawing)paintMask(p);
  });
  const endPointer=()=>{if(state.dragging>=0)setStatus('Parede ajustada. Escolha a textura e faça as correções necessárias.');state.dragging=-1;state.drawing=false};
  canvas.addEventListener('pointerup',endPointer);canvas.addEventListener('pointercancel',endPointer);

  function setMode(mode) {
    state.mode=mode;document.querySelectorAll('[data-mode]').forEach(b=>{const on=b.dataset.mode===mode;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on))});
    canvas.style.cursor=mode==='corners'?'move':'crosshair';scheduleRender();
    setStatus(mode==='identify'?'Clique no centro da parede ou do piso.':mode==='corners'?'Arraste os pontos amarelos.':mode==='brush'?'Pinte para acrescentar revestimento.':'Apague sobre portas, janelas, quadros e móveis.');
  }
  document.querySelectorAll('[data-mode]').forEach(b=>b.addEventListener('click',()=>b.dataset.mode==='identify'?enableIdentifyMode():setMode(b.dataset.mode)));

  function fitCanvas() {
    if(!state.photo)return;const available=Math.max(280,$('stage').clientWidth-4);canvas.style.width=`${Math.min(available,canvas.width)}px`;canvas.style.height='auto';$('zoom').value='100';$('zoomOut').value='100%';
  }
  $('zoom').addEventListener('input',()=>{if(!state.photo)return;const base=Math.min(Math.max(280,$('stage').clientWidth-4),canvas.width);canvas.style.width=`${base*+$('zoom').value/100}px`;$('zoomOut').value=$('zoom').value+'%'});

  function resetAll(){if(!state.photo)return;pushHistory();const w=canvas.width,h=canvas.height;state.corners=[{x:w*.18,y:h*.18},{x:w*.82,y:h*.18},{x:w*.88,y:h*.82},{x:w*.12,y:h*.82}];resetMaskToPolygon();$('cols').value=4;$('rows').value=3;$('joint').value=1;$('scale').value=120;$('rotation').value=0;$('opacity').value=100;$('shadow').value=0;$('fillGaps').checked=true;updateOutputs();fitCanvas();scheduleRender();setStatus('Simulação reiniciada. Ajuste novamente os quatro cantos.');}
  function updateOutputs(){$('colsOut').value=$('cols').value;$('rowsOut').value=$('rows').value;$('total').textContent=$('cols').value+' × '+$('rows').value+' = '+($('cols').value*$('rows').value)+' peças na área completa';$('scaleOut').value=$('scale').value;$('rotationOut').value=$('rotation').value+'°';$('opacityOut').value=$('opacity').value+'%';$('shadowOut').value=$('shadow').value+'%';$('brushOut').value=$('brushSize').value}
  ['cols','rows','joint','scale','rotation','opacity','shadow','brushSize'].forEach(id=>$(id).addEventListener('input',()=>{updateOutputs();scheduleRender()}));

  function download() {
    if(!state.photo)return;const priorMode=state.mode,priorBefore=state.showBefore;state.mode='none';state.showBefore=false;render();
    canvas.toBlob(blob=>{const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='simulacao-revestimento.png';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);state.mode=priorMode;state.showBefore=priorBefore;scheduleRender();setStatus('Imagem preparada para download.')},'image/png',.94);
  }

  const photoHandler=e=>loadFile(e.target.files[0],setPhoto);
  $('photoInput').addEventListener('change',photoHandler);$('emptyPhotoInput').addEventListener('change',photoHandler);
  $('textureInput').addEventListener('change',e=>loadFile(e.target.files[0],image=>{state.texture=image;$('scale').value=120;$('rotation').value=0;updateOutputs();state.textureName=e.target.files[0].name;document.querySelectorAll('.texture-option').forEach(b=>b.setAttribute('aria-checked','false'));scheduleRender();setStatus(`Textura “${state.textureName}” carregada.`)}));
  $('beforeBtn').addEventListener('click',()=>{state.showBefore=!state.showBefore;$('beforeBtn').textContent=state.showBefore?'Ver simulação':'Antes/depois';scheduleRender()});
  $('undoBtn').addEventListener('click',undo);$('resetBtn').addEventListener('click',resetAll);$('downloadBtn').addEventListener('click',download);
  window.addEventListener('resize',()=>{if(+$('zoom').value===100)fitCanvas()});
  updateOutputs();render();
})();
