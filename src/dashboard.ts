import { createServer, IncomingMessage, ServerResponse } from 'node:http';

import { DASHBOARD_PORT } from './config.js';
import {
  deleteTask,
  getDashboardGroups,
  getDashboardTasks,
  updateTask,
} from './db.js';
import { logger } from './logger.js';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NanoClaw</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh}
    header{background:#161b22;border-bottom:1px solid #30363d;padding:14px 24px;display:flex;align-items:center;gap:10px}
    header h1{font-size:17px;font-weight:600}
    .dot{width:8px;height:8px;border-radius:50%;background:#3fb950;margin-left:auto;animation:pulse 2s infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
    .ts{font-size:11px;color:#6e7681}
    main{padding:20px;display:grid;gap:16px}
    .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
    .stat{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px}
    .stat .val{font-size:26px;font-weight:700;color:#58a6ff}
    .stat .lbl{font-size:11px;color:#8b949e;margin-top:3px}
    section{background:#161b22;border:1px solid #30363d;border-radius:8px;overflow:hidden}
    section h2{font-size:11px;font-weight:600;padding:10px 16px;border-bottom:1px solid #30363d;color:#8b949e;text-transform:uppercase;letter-spacing:.06em}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th{text-align:left;padding:7px 16px;color:#8b949e;font-weight:500;font-size:11px;border-bottom:1px solid #21262d}
    td{padding:7px 16px;border-bottom:1px solid #21262d;vertical-align:middle}
    tr:last-child td{border-bottom:none}
    tr:hover td{background:#21262d55}
    .pill{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:500;margin:1px}
    .g{background:#1a3a2a;color:#3fb950}.y{background:#3a2f1a;color:#d29922}
    .gr{background:#21262d;color:#8b949e}.b{background:#1a2a3a;color:#58a6ff}
    .r{background:#3a1a1a;color:#f85149}
    .mono{font-family:'SF Mono',Consolas,monospace;font-size:11px}
    .dim{color:#6e7681;font-size:12px}
    .trunc{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .feed{padding:0}
    .msg{padding:9px 16px;border-bottom:1px solid #21262d;display:flex;gap:14px;align-items:flex-start}
    .msg:last-child{border-bottom:none}
    .msg-meta{min-width:140px;flex-shrink:0}
    .msg-group{font-size:12px;font-weight:600;color:#58a6ff}
    .msg-sender{font-size:11px;color:#8b949e;margin-top:1px}
    .msg-time{font-size:11px;color:#6e7681;margin-top:1px}
    .msg-content{font-size:13px;color:#e6edf3;flex:1;word-break:break-word}
    .msg-content.bot{color:#6e7681;font-style:italic}
    .empty{padding:20px 16px;text-align:center;color:#6e7681;font-size:13px}
    /* Action buttons */
    .btn{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:6px;font-size:11px;font-weight:500;cursor:pointer;border:1px solid;background:transparent;transition:all .15s}
    .btn-pause{border-color:#d29922;color:#d29922}.btn-pause:hover{background:#3a2f1a}
    .btn-resume{border-color:#3fb950;color:#3fb950}.btn-resume:hover{background:#1a3a2a}
    .btn-edit{border-color:#58a6ff;color:#58a6ff}.btn-edit:hover{background:#1a2a3a}
    .btn-del{border-color:#f85149;color:#f85149}.btn-del:hover{background:#3a1a1a}
    .btn-save{border-color:#3fb950;color:#3fb950;padding:6px 16px;font-size:13px}.btn-save:hover{background:#1a3a2a}
    .btn-cancel{border-color:#6e7681;color:#8b949e;padding:6px 16px;font-size:13px}.btn-cancel:hover{background:#21262d}
    .actions{display:flex;gap:6px;flex-wrap:wrap}
    /* Modal */
    .overlay{display:none;position:fixed;inset:0;background:#00000088;z-index:100;align-items:center;justify-content:center}
    .overlay.open{display:flex}
    .modal{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:24px;width:100%;max-width:520px;display:grid;gap:16px}
    .modal h3{font-size:15px;font-weight:600}
    .field{display:grid;gap:6px}
    .field label{font-size:12px;color:#8b949e}
    .field input,.field textarea,.field select{background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#e6edf3;padding:8px 10px;font-size:13px;font-family:inherit;width:100%;outline:none}
    .field input:focus,.field textarea:focus,.field select:focus{border-color:#58a6ff}
    .field textarea{resize:vertical;min-height:80px}
    .modal-actions{display:flex;gap:8px;justify-content:flex-end}
    .hint{font-size:11px;color:#6e7681}
  </style>
</head>
<body>
  <header>
    <h1>🦇 NanoClaw</h1>
    <div class="dot" id="dot" style="background:#8b949e"></div>
    <span class="ts" id="ts"></span>
  </header>
  <main>
    <div class="stats" id="stats">
      <div class="stat"><div class="val">—</div><div class="lbl">Groups</div></div>
      <div class="stat"><div class="val">—</div><div class="lbl">Active Tasks</div></div>
      <div class="stat"><div class="val">—</div><div class="lbl">Paused Tasks</div></div>
    </div>
    <section>
      <h2>Scheduled Tasks <label style="float:right;font-size:11px;font-weight:400;color:#8b949e;cursor:pointer"><input type="checkbox" id="show-completed" onchange="renderTasks()" style="margin-right:4px">Show completed</label></h2>
      <div id="tasks-body"><div class="empty">Loading…</div></div>
    </section>
    <section>
      <h2>Groups</h2>
      <div id="groups-body"><div class="empty">Loading…</div></div>
    </section>
  </main>

  <!-- Edit task modal -->
  <div class="overlay" id="modal">
    <div class="modal">
      <h3>Edit Task</h3>
      <div class="field">
        <label>Prompt</label>
        <textarea id="e-prompt" rows="4"></textarea>
      </div>
      <div class="field">
        <label>Schedule type</label>
        <select id="e-type">
          <option value="cron">cron</option>
          <option value="interval">interval (ms)</option>
          <option value="once">once</option>
        </select>
      </div>
      <div class="field">
        <label>Schedule value</label>
        <input id="e-value" type="text">
        <span class="hint">Cron: "0 9 * * *" — Interval: milliseconds — Once: ISO date</span>
      </div>
      <div class="field">
        <label>Status</label>
        <select id="e-status">
          <option value="active">active</option>
          <option value="paused">paused</option>
        </select>
      </div>
      <div class="modal-actions">
        <button class="btn btn-cancel" onclick="closeModal()">Cancel</button>
        <button class="btn btn-save" onclick="saveTask()">Save</button>
      </div>
    </div>
  </div>

  <script>
    let tasks=[];
    let editingId=null;

    function ago(iso){
      if(!iso)return'—';
      const s=Math.floor((Date.now()-new Date(iso).getTime())/1000);
      if(s<5)return'just now';if(s<60)return s+'s ago';
      if(s<3600)return Math.floor(s/60)+'m ago';
      if(s<86400)return Math.floor(s/3600)+'h ago';
      return Math.floor(s/86400)+'d ago';
    }
    function pill(t,c){return'<span class="pill '+c+'">'+esc(t)+'</span>'}
    function esc(s){return s?String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'):''}
    function trunc(s,n){return s&&s.length>n?s.slice(0,n)+'…':s||''}

    function openModal(i){
      const t=tasks[i];
      if(!t)return;
      editingId=t.id;
      document.getElementById('e-prompt').value=t.prompt||'';
      document.getElementById('e-type').value=t.schedule_type||'cron';
      document.getElementById('e-value').value=t.schedule_value||'';
      document.getElementById('e-status').value=t.status||'active';
      document.getElementById('modal').classList.add('open');
    }
    function closeModal(){
      document.getElementById('modal').classList.remove('open');
      editingId=null;
    }
    // Close on overlay click
    document.getElementById('modal').addEventListener('click',function(e){
      if(e.target===this)closeModal();
    });

    async function saveTask(){
      if(!editingId)return;
      const body={
        prompt:document.getElementById('e-prompt').value.trim(),
        schedule_type:document.getElementById('e-type').value,
        schedule_value:document.getElementById('e-value').value.trim(),
        status:document.getElementById('e-status').value,
      };
      await fetch('/api/tasks/'+editingId,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      closeModal();
      refresh();
    }

    async function toggleStatus(i){
      const t=tasks[i];
      if(!t)return;
      const status=t.status==='active'?'paused':'active';
      await fetch('/api/tasks/'+t.id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})});
      refresh();
    }

    async function delTask(i){
      const t=tasks[i];
      if(!t)return;
      if(!confirm('Delete task "'+trunc(t.prompt,40)+'"?'))return;
      await fetch('/api/tasks/'+t.id,{method:'DELETE'});
      refresh();
    }

    function renderTasks(){
      const showCompleted=document.getElementById('show-completed').checked;
      const visible=tasks.filter(t=>showCompleted||t.status!=='completed');
      if(!visible.length){
        document.getElementById('tasks-body').innerHTML='<div class="empty">'+(tasks.length?'No active/paused tasks — check "Show completed" to see all':'No scheduled tasks')+'</div>';
        return;
      }
      document.getElementById('tasks-body').innerHTML='<table><thead><tr><th>Group</th><th>Prompt</th><th>Schedule</th><th>Next Run</th><th>Last Run</th><th>Status</th><th>Actions</th></tr></thead><tbody>'+
        visible.map((t,i)=>{
          const isActive=t.status==='active';
          const realIdx=tasks.indexOf(t);
          return '<tr>'+
            '<td class="mono dim">'+esc(t.group_folder)+'</td>'+
            '<td class="trunc dim" title="'+esc(t.prompt)+'">'+esc(trunc(t.prompt,55))+'</td>'+
            '<td><span class="pill gr mono">'+esc(t.schedule_type)+'</span><br><span class="mono dim">'+esc(trunc(t.schedule_value,20))+'</span></td>'+
            '<td class="dim">'+ago(t.next_run)+'</td>'+
            '<td class="dim">'+ago(t.last_run)+'</td>'+
            '<td>'+pill(t.status,isActive?'g':t.status==='paused'?'y':'gr')+'</td>'+
            '<td><div class="actions">'+
              (t.status!=='completed'?'<button class="btn '+(isActive?'btn-pause':'btn-resume')+'" onclick="toggleStatus('+realIdx+')">'+(isActive?'⏸ Pause':'▶ Resume')+'</button>':'')+
              '<button class="btn btn-edit" onclick="openModal('+realIdx+')">✏ Edit</button>'+
              '<button class="btn btn-del" onclick="delTask('+realIdx+')">🗑 Del</button>'+
            '</div></td>'+
          '</tr>';
        }).join('')+'</tbody></table>';
    }

    async function refresh(){
      try{
        const[groups,tasksData]=await Promise.all([
          fetch('/api/groups').then(r=>r.json()),
          fetch('/api/tasks').then(r=>r.json()),
        ]);
        tasks=tasksData;

        document.getElementById('dot').style.background='#3fb950';
        document.getElementById('ts').textContent='Updated '+new Date().toLocaleTimeString();

        // Stats
        const active=tasks.filter(t=>t.status==='active').length;
        const paused=tasks.filter(t=>t.status==='paused').length;
        document.getElementById('stats').innerHTML=[
          {val:groups.length,lbl:'Groups'},
          {val:active,lbl:'Active Tasks'},
          {val:paused,lbl:'Paused Tasks'},
        ].map(s=>'<div class="stat"><div class="val">'+s.val+'</div><div class="lbl">'+s.lbl+'</div></div>').join('');

        // Groups
        if(!groups.length){
          document.getElementById('groups-body').innerHTML='<div class="empty">No groups registered</div>';
        }else{
          document.getElementById('groups-body').innerHTML='<table><thead><tr><th>Name</th><th>Channel</th><th>JID</th><th>Last Activity</th><th>Flags</th></tr></thead><tbody>'+
            groups.map(g=>'<tr>'+
              '<td><strong>'+esc(g.name)+'</strong><br><span class="dim mono">'+esc(g.folder)+'</span></td>'+
              '<td>'+pill(g.channel||'whatsapp','b')+'</td>'+
              '<td class="mono dim trunc" title="'+esc(g.jid)+'">'+esc(trunc(g.jid,28))+'</td>'+
              '<td class="dim">'+ago(g.last_message_time)+'</td>'+
              '<td>'+(g.is_main?pill('main','g'):'')+(g.requires_trigger?pill('trigger','y'):pill('always-on','g'))+(g.model_provider==='ollama'?pill('ollama','gr'):'')+'</td>'+
            '</tr>').join('')+'</tbody></table>';
        }

        renderTasks();
      }catch(e){
        document.getElementById('dot').style.background='#f85149';
        document.getElementById('ts').textContent='Error: '+e.message;
      }
    }

    refresh();
    setInterval(refresh,15000);
  </script>
</body>
</html>`;

export function startDashboard(): void {
  const port = DASHBOARD_PORT;

  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? '/';
      const method = req.method ?? 'GET';

      // PATCH /api/tasks/:id
      const taskMatch = url.match(/^\/api\/tasks\/([^/]+)$/);

      if (url === '/' || url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(HTML);
        return;
      }

      if (url === '/api/groups' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getDashboardGroups()));
        return;
      }

      if (url === '/api/tasks' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getDashboardTasks()));
        return;
      }

      if (taskMatch && method === 'PATCH') {
        const id = decodeURIComponent(taskMatch[1]);
        try {
          const raw = await readBody(req);
          const body = JSON.parse(raw) as Record<string, string>;
          updateTask(id, {
            prompt: body.prompt,
            schedule_type: body.schedule_type as 'cron' | 'interval' | 'once',
            schedule_value: body.schedule_value,
            status: body.status as 'active' | 'paused' | 'completed',
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
        return;
      }

      if (taskMatch && method === 'DELETE') {
        const id = decodeURIComponent(taskMatch[1]);
        try {
          deleteTask(id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    },
  );

  server.listen(port, '127.0.0.1', () => {
    logger.info(`Dashboard: http://localhost:${port}`);
  });

  server.on('error', (err) => {
    logger.error({ err }, 'Dashboard server error');
  });
}
