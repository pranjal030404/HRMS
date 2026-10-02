import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg } from '../api';
import { Spinner, useToast, Empty } from '../components/ui';

export default function AiAssistant() {
  const toast = useToast();
  const [suggestions, setSuggestions] = useState([]);
  const [history, setHistory] = useState([]);
  const [messages, setMessages] = useState([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [anomalies, setAnomalies] = useState(null);
  const endRef = useRef(null);

  const load = async () => {
    try {
      const [s, h, a] = (await Promise.all([
        api.get('/ai/suggestions'), api.get('/ai/history'), api.get('/ai/anomalies').catch(() => ({ data: { data: [] } })),
      ])).map((x) => x.data.data);
      setSuggestions(s); setHistory(h); setAnomalies(a);
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, busy]);

  const ask = async (q) => {
    const text = (q || question).trim();
    if (!text || busy) return;
    setQuestion('');
    setMessages((m) => [...m, { role: 'user', text }]);
    setBusy(true);
    try {
      const { data } = await api.post('/ai/ask', { question: text });
      setMessages((m) => [...m, { role: 'ai', text: data.data.answer, intent: data.data.intent, link: data.data.link, blocked: data.data.intent === 'blocked' }]);
      load();
    } catch (e) {
      toast(errMsg(e), true);
      setMessages((m) => [...m, { role: 'ai', text: 'Sorry, something went wrong.', blocked: true }]);
    }
    setBusy(false);
  };

  return (
    <>
      <div className="spread" style={{ marginBottom: 10 }}>
        <div>
          <h2 style={{ fontSize: 17 }}>AI HR Assistant</h2>
          <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>
            Ask questions about your HR data — answers respect your existing permissions and are read-only. Nothing is changed without a human approving it elsewhere.
          </p>
        </div>
      </div>

      {anomalies?.length > 0 && (
        <div className="card mb" style={{ borderLeft: '3px solid #f79009' }}>
          <div className="card-h"><h3>⚠️ Anomalies detected</h3></div>
          <div className="card-b">
            {anomalies.map((a, i) => (
              <div key={i} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                <span className={'badge ' + (a.severity === 'high' ? 'red' : 'amber')}>{a.type}</span> {a.message}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid c2">
        <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 420 }}>
          <div className="card-h"><h3>Chat</h3></div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 14, maxHeight: 420 }}>
            {messages.length === 0 && !busy && (
              <Empty icon="🤖" text="Ask something like “How many employees do we have?” or pick a suggestion →" />
            )}
            {messages.map((m, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', marginBottom: 10 }}>
                <div style={{
                  maxWidth: '85%', padding: '9px 12px', borderRadius: 10, fontSize: 13.5, whiteSpace: 'pre-wrap',
                  background: m.role === 'user' ? 'var(--primary)' : 'var(--bg, #f2f4f7)', color: m.role === 'user' ? '#fff' : 'var(--text)',
                }}>
                  {m.text.split('\n').map((line, j) => (
                    <div key={j} dangerouslySetInnerHTML={{ __html: line.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>') || '&nbsp;' }} />
                  ))}
                  {m.link && <div style={{ marginTop: 6 }}><Link to={m.link} style={{ fontSize: 12.5 }}>Open related module →</Link></div>}
                  {m.blocked && <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>You lack the permission this answer needs.</div>}
                </div>
              </div>
            ))}
            {busy && <div style={{ color: 'var(--muted)', fontSize: 13 }}>Thinking…</div>}
            <div ref={endRef} />
          </div>
          <form className="spread" style={{ gap: 8, padding: 12, borderTop: '1px solid var(--border)' }}
            onSubmit={(e) => { e.preventDefault(); ask(); }}>
            <input style={{ flex: 1 }} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask about headcount, payroll, attendance…" />
            <button className="btn sm" disabled={busy || !question.trim()}>Ask</button>
          </form>
        </div>

        <div>
          <div className="card">
            <div className="card-h"><h3>Suggested questions</h3></div>
            <div className="card-b">
              {suggestions.map((s) => (
                <button key={s} className="btn secondary sm" style={{ margin: '0 6px 6px 0' }} onClick={() => ask(s)}>{s}</button>
              ))}
            </div>
          </div>
          <div className="card mt">
            <div className="card-h"><h3>Recent questions</h3></div>
            <div className="card-b" style={{ maxHeight: 220, overflowY: 'auto' }}>
              {history.length === 0 && <Empty text="No history yet" />}
              {history.map((h) => (
                <div key={h.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 12.5 }}>
                  <b>{h.question}</b>
                  <div style={{ color: 'var(--muted)' }}>{h.intent} · {h.status} · {new Date(h.created_at).toLocaleString('en-IN')}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
