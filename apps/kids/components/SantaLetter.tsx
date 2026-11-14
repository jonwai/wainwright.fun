import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { fetchKidSanta, sendKidSanta, type SantaLetterRecord, type SantaQuestion } from "../lib/kidApi";
import { composeSantaLetter, santaLetterBlocks, SANTA_MAX_DRAWING_BYTES, SANTA_MAX_OWN_LINE, SANTA_MAX_PICKS } from "../../../packages/local/src/santa-catalog";

interface Choice {
  picks: string[];
  favourite: string | null;
}

const PAPER = "#fffaf3";
const PENS = [
  { id: "red", color: "#b42318", label: "Red" },
  { id: "green", color: "#1f7a4d", label: "Green" },
  { id: "gold", color: "#c9a227", label: "Gold" },
] as const;

function emptyChoices(questions: SantaQuestion[]): Record<string, Choice> {
  return Object.fromEntries(questions.map((question) => [question.id, { picks: [], favourite: null }]));
}

function choicesFromLetter(questions: SantaQuestion[], letter: SantaLetterRecord): Record<string, Choice> {
  const choices = emptyChoices(questions);
  for (const question of questions) {
    const stored = letter.answers[question.id];
    if (!stored) continue;
    const allowed = new Set(question.options.map((option) => option.id));
    const picks = stored.picks.map((pick) => pick.id).filter((id) => allowed.has(id)).slice(0, SANTA_MAX_PICKS);
    choices[question.id] = {
      picks,
      favourite: stored.favourite && picks.includes(stored.favourite) ? stored.favourite : null,
    };
  }
  return choices;
}

function letterFromChoices(
  childId: string,
  name: string,
  age: number | null,
  questions: SantaQuestion[],
  choices: Record<string, Choice>,
  ownLine: string,
  hasDrawing: boolean,
): string {
  const sections = questions.flatMap((question) => {
    const choice = choices[question.id];
    if (!choice || choice.picks.length === 0) return [];
    const picks = choice.picks.flatMap((id) => {
      const option = question.options.find((item) => item.id === id);
      return option ? [{ id: option.id, phrase: option.phrase?.trim() || option.label }] : [];
    });
    if (picks.length === 0) return [];
    return [{ questionId: question.id, picks, favourite: choice.favourite }];
  });
  if (sections.length === 0) return "";
  return composeSantaLetter({
    childId,
    childName: name,
    age,
    sections,
    ownLine: ownLine.trim() || null,
    hasDrawing,
  });
}

function LetterPaper({ text, drawing }: { text: string; drawing?: string | null }) {
  const blocks = santaLetterBlocks(text);
  return (
    <div className="santa-paper">
      {blocks.map((block, index) => {
        if (block.kind === "salutation") return <p className="santa-salutation" key={index}>{block.text}</p>;
        if (block.kind === "signoff") {
          return (
            <p className="santa-signoff" key={index}>
              {block.text.split("\n").map((line, lineIndex) => (
                <span key={lineIndex}>{line}</span>
              ))}
            </p>
          );
        }
        return <p key={index}>{block.text}</p>;
      })}
      {drawing && <img src={drawing} alt="Drawing on the letter" />}
    </div>
  );
}

/**
 * Festive letter at the top of the home-network launcher. The server decides whether
 * it is open and which choices this child gets. Before opening day this renders nothing.
 */
export function SantaLetter() {
  const [hidden, setHidden] = useState(false);
  const [questions, setQuestions] = useState<SantaQuestion[] | null>(null);
  const [style, setStyle] = useState<"reading" | "tiles">("tiles");
  const [childId, setChildId] = useState("");
  const [childName, setChildName] = useState("");
  const [age, setAge] = useState<number | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [ownLine, setOwnLine] = useState("");
  const [drawing, setDrawing] = useState<string | null>(null);
  const [seedDrawing, setSeedDrawing] = useState<string | null>(null);
  const [sent, setSent] = useState<SantaLetterRecord | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchKidSanta()
      .then((state) => {
        if (cancelled) return;
        if (!state.open || !state.questions) {
          setHidden(true);
          return;
        }
        setQuestions(state.questions);
        setStyle(state.style === "reading" ? "reading" : "tiles");
        setChildId(state.child?.id ?? "");
        setChildName(state.child?.name ?? "");
        setAge(typeof state.age === "number" && Number.isInteger(state.age) && state.age >= 0 ? state.age : null);
        if (state.latest) {
          setSent(state.latest);
          setChoices(choicesFromLetter(state.questions, state.latest));
          setOwnLine(state.latest.ownLine ?? "");
          setDrawing(state.latest.drawingPng);
          setSeedDrawing(state.latest.drawingPng);
          setEditing(false);
        } else {
          setChoices(emptyChoices(state.questions));
          setEditing(true);
        }
      })
      .catch(() => {
        if (!cancelled) setHidden(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (hidden || !questions) return null;

  const preview = letterFromChoices(childId, childName, age, questions, choices, ownLine, drawing != null);
  const showForm = editing || !sent;

  function toggle(questionId: string, optionId: string) {
    setHint(null);
    setChoices((current) => {
      const choice = current[questionId] ?? { picks: [], favourite: null };
      if (choice.picks.includes(optionId)) {
        const picks = choice.picks.filter((id) => id !== optionId);
        return { ...current, [questionId]: { picks, favourite: choice.favourite === optionId ? null : choice.favourite } };
      }
      if (choice.picks.length >= SANTA_MAX_PICKS) {
        setHint("Pick up to 3.");
        return current;
      }
      return { ...current, [questionId]: { ...choice, picks: [...choice.picks, optionId] } };
    });
  }

  function star(questionId: string, optionId: string) {
    setChoices((current) => {
      const choice = current[questionId] ?? { picks: [], favourite: null };
      if (!choice.picks.includes(optionId)) return current;
      return { ...current, [questionId]: { ...choice, favourite: choice.favourite === optionId ? null : optionId } };
    });
  }

  function edit() {
    if (sent && questions) {
      setChoices(choicesFromLetter(questions, sent));
      setOwnLine(sent.ownLine ?? "");
      setDrawing(sent.drawingPng);
      setSeedDrawing(sent.drawingPng);
    }
    setProblem(null);
    setEditing(true);
  }

  async function send() {
    if (!preview) {
      setProblem("Choose at least one thing you love");
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const letter = await sendKidSanta({
        answers: Object.fromEntries(
          questions.map((question) => {
            const choice = choices[question.id] ?? { picks: [], favourite: null };
            return [question.id, choice];
          }),
        ),
        ownLine,
        drawing,
      });
      setSent(letter);
      setEditing(false);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Could not send the letter");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`santa-letter is-${style} mb-8`} aria-label="Letter to Santa">
      <div className="santa-sky" aria-hidden="true">
        {Array.from({ length: 12 }, (_, i) => (
          <span key={i} className="santa-flake" style={{ "--i": String(i) } as CSSProperties} />
        ))}
        <span className="santa-twinkle santa-twinkle-a" />
        <span className="santa-twinkle santa-twinkle-b" />
        <span className="santa-twinkle santa-twinkle-c" />
      </div>
      <div className="santa-body">
        <p className="santa-kicker">Christmas</p>
        <h2 className="santa-title">Letter to Santa</h2>
        {showForm ? (
          <>
            <p className="santa-intro">Tell Santa some things you love. Star your favourite if you want to.</p>
            {questions.map((question) => {
              const choice = choices[question.id] ?? { picks: [], favourite: null };
              return (
                <fieldset key={question.id} className="santa-question">
                  <legend>{question.prompt}</legend>
                  <div className="santa-options">
                    {question.options.map((option) => {
                      const selected = choice.picks.includes(option.id);
                      const favourite = choice.favourite === option.id;
                      return (
                        <div key={option.id} className={`santa-option${selected ? " is-selected" : ""}${favourite ? " is-favourite" : ""}`}>
                          <button type="button" className="santa-option-main" aria-pressed={selected} onClick={() => toggle(question.id, option.id)}>
                            <span className="santa-emoji" aria-hidden="true">{option.emoji}</span>
                            <span className="santa-label">{option.label}</span>
                          </button>
                          {selected && (
                            <button
                              type="button"
                              className="santa-star"
                              aria-pressed={favourite}
                              aria-label={favourite ? `${option.label} is your favourite` : `Star ${option.label} as favourite`}
                              onClick={() => star(question.id, option.id)}
                            >
                              {favourite ? "★" : "☆"}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </fieldset>
              );
            })}
            {hint && <p className="santa-hint">{hint}</p>}
            <label className="santa-own">
              <span>Add your own line</span>
              <input
                value={ownLine}
                maxLength={SANTA_MAX_OWN_LINE}
                autoComplete="off"
                placeholder="Something you'd like Santa to know"
                onChange={(event) => setOwnLine(event.target.value)}
              />
            </label>
            <SantaDrawing
              key={seedDrawing ?? "blank"}
              seed={seedDrawing}
              penWidth={style === "tiles" ? 10 : 5}
              onChange={setDrawing}
            />
            {preview && (
              <div aria-live="polite">
                <LetterPaper text={preview} />
              </div>
            )}
            {problem && <p className="santa-problem" role="alert">{problem}</p>}
            <div className="santa-actions">
              <button type="button" className="santa-send" disabled={busy || !preview} onClick={() => void send()}>
                {busy ? "Sending…" : "Send to Santa"}
              </button>
              {sent && (
                <button type="button" className="santa-secondary" disabled={busy} onClick={() => setEditing(false)}>
                  Keep the letter I sent
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="santa-sent">
            <p className="santa-on-the-way" role="status">Your letter is on its way to the North Pole!</p>
            {sent && <LetterPaper text={sent.letterText} drawing={sent.drawingPng} />}
            <button type="button" className="santa-secondary" onClick={edit}>
              Edit and send again
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function SantaDrawing({ seed, penWidth, onChange }: { seed: string | null; penWidth: number; onChange: (png: string | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [pen, setPen] = useState<(typeof PENS)[number]["id"]>("red");
  const penRef = useRef(pen);
  penRef.current = pen;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (!seed) {
      onChange(null);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      onChange(seed);
    };
    img.src = seed;
    return () => {
      cancelled = true;
    };
  }, [seed, onChange]);

  function color() {
    return PENS.find((item) => item.id === penRef.current)?.color ?? PENS[0].color;
  }

  function point(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function snapshot() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const png = canvas.toDataURL("image/png");
    if (png.length > SANTA_MAX_DRAWING_BYTES * 2) {
      onChange(null);
      return;
    }
    onChange(png);
  }

  function start(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const at = point(event);
    if (!canvas || !ctx || !at) return;
    drawing.current = true;
    canvas.setPointerCapture(event.pointerId);
    ctx.strokeStyle = color();
    ctx.lineWidth = penWidth;
    ctx.beginPath();
    ctx.moveTo(at.x, at.y);
  }

  function move(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    const at = point(event);
    if (!ctx || !at) return;
    ctx.lineTo(at.x, at.y);
    ctx.stroke();
  }

  function end(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    drawing.current = false;
    const canvas = canvasRef.current;
    if (canvas?.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    snapshot();
  }

  function clear() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    onChange(null);
  }

  return (
    <div className="santa-draw">
      <div className="santa-draw-head">
        <span>Draw a picture</span>
        <div className="santa-pens">
          {PENS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`santa-pen${pen === item.id ? " is-selected" : ""}`}
              style={{ background: item.color }}
              aria-label={item.label}
              aria-pressed={pen === item.id}
              onClick={() => setPen(item.id)}
            />
          ))}
          <button type="button" className="santa-clear" onClick={clear}>
            Clear
          </button>
        </div>
      </div>
      <canvas
        ref={canvasRef}
        width={640}
        height={220}
        aria-label="Drawing for Santa"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      />
    </div>
  );
}
