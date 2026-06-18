import { useMemo, useState, useEffect, useRef } from "react";

type AgentType = "explorer" | "browser" | "regression";

interface AgentState {
  id: string;
  type: AgentType;
  name: string;
  status: "running" | "done";
  currentPath: string;
  findingsCount: number;
  lastFinding: string;
  yPercent: number;
  swimDuration: number;
  swimDelay: number;
  bobDuration: number;
  bobDelay: number;
  reverseSwim: boolean;
}

const Y_SLOTS = [10, 24, 38, 52, 66, 80, 17, 31, 45, 59, 73, 87];

const COLORS: Record<AgentType, { bg: string; text: string; dot: string; glow: string }> = {
  explorer:   { bg: "rgba(59,130,246,0.12)",  text: "#93c5fd", dot: "#3b82f6", glow: "#3b82f620" },
  browser:    { bg: "rgba(34,197,94,0.12)",   text: "#86efac", dot: "#22c55e", glow: "#22c55e20" },
  regression: { bg: "rgba(249,115,22,0.12)",  text: "#fdba74", dot: "#f97316", glow: "#f9731620" },
};

const TYPE_LABEL: Record<AgentType, string> = {
  explorer: "EX",
  browser: "BR",
  regression: "RG",
};

function parseAgents(lines: string[]): AgentState[] {
  const map = new Map<string, AgentState>();
  let lastId: string | null = null;
  let count = 0;

  for (const line of lines) {
    const startM = line.match(/^\[(explorer|browser|regression)\] (.+?) start/);
    if (startM) {
      const type = startM[1] as AgentType;
      const name = startM[2];
      const id = `${type}:${name}`;
      if (!map.has(id)) {
        const slot = count++;
        map.set(id, {
          id, type, name,
          status: "running",
          currentPath: "/",
          findingsCount: 0,
          lastFinding: "",
          yPercent: Y_SLOTS[slot % Y_SLOTS.length],
          swimDuration: 7 + (slot % 5),
          swimDelay: -(slot * 1.7),
          bobDuration: 2.5 + (slot % 3) * 0.5,
          bobDelay: -(slot * 0.6),
          reverseSwim: slot % 2 !== 0,
        });
      } else {
        map.get(id)!.status = "running";
      }
      lastId = id;
      continue;
    }

    const doneM = line.match(/^\[(explorer|browser|regression)\] (.+?) (?:done|cancelled)/);
    if (doneM) {
      const id = `${doneM[1]}:${doneM[2]}`;
      if (map.has(id)) map.get(id)!.status = "done";
      if (lastId === id) lastId = null;
      continue;
    }

    const navM = line.match(/→ navigate\(\{[^}]*"path"\s*:\s*"([^"]+)"/);
    if (navM && lastId && map.has(lastId)) {
      map.get(lastId)!.currentPath = navM[1];
      continue;
    }

    const findM = line.match(/→ \[findings\] saved: "([^"]+)"/);
    if (findM && lastId && map.has(lastId)) {
      const ag = map.get(lastId)!;
      ag.findingsCount += 1;
      ag.lastFinding = findM[1];
    }
  }

  return Array.from(map.values());
}

const KEYFRAMES = `
@keyframes shoal-swim {
  from { left: 2%; }
  to   { left: calc(100% - 280px); }
}
@keyframes shoal-bob {
  from { transform: translateY(0); }
  to   { transform: translateY(9px); }
}
@keyframes shoal-pulse {
  0%, 100% { opacity: 0.55; transform: scale(1); }
  50%       { opacity: 1;    transform: scale(1.15); }
}
@keyframes shoal-fade-in {
  from { opacity: 0; transform: scale(0.85); }
  to   { opacity: 1; transform: scale(1); }
}
`;

export function SwarmVisualizer({ logLines, isLive }: { logLines: string[]; isLive: boolean }) {
  const agents = useMemo(() => parseAgents(logLines), [logLines]);
  const running = agents.filter((a) => a.status === "running");
  const done = agents.filter((a) => a.status === "done");

  return (
    <div style={styles.container}>
      <style>{KEYFRAMES}</style>
      <div style={styles.waterLayer} />

      {agents.length === 0 ? (
        <div style={styles.empty}>
          {isLive ? "Waiting for agents to start…" : "No agent activity recorded"}
        </div>
      ) : (
        <>
          {running.map((agent) => (
            <FishChip key={agent.id} agent={agent} />
          ))}

          {done.length > 0 && (
            <div style={styles.doneRow}>
              {done.map((agent) => {
                const c = COLORS[agent.type];
                return (
                  <span
                    key={agent.id}
                    style={{ ...styles.doneBadge, color: c.text, borderColor: `${c.dot}44` }}
                  >
                    ✓ {agent.name}
                  </span>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FishChip({ agent }: { agent: AgentState }) {
  const c = COLORS[agent.type];
  const [flashing, setFlashing] = useState(false);
  const prevFindings = useRef(agent.findingsCount);

  useEffect(() => {
    if (agent.findingsCount > prevFindings.current) {
      prevFindings.current = agent.findingsCount;
      setFlashing(true);
      const t = setTimeout(() => setFlashing(false), 1500);
      return () => clearTimeout(t);
    }
  }, [agent.findingsCount]);

  const path =
    agent.currentPath.length > 26
      ? "…" + agent.currentPath.slice(-26)
      : agent.currentPath;

  return (
    <div
      style={{
        position: "absolute",
        top: `${agent.yPercent}%`,
        animationName: "shoal-swim",
        animationDuration: `${agent.swimDuration}s`,
        animationDelay: `${agent.swimDelay}s`,
        animationTimingFunction: "ease-in-out",
        animationIterationCount: "infinite",
        animationDirection: agent.reverseSwim ? "alternate-reverse" : "alternate",
        animationFillMode: "both",
      }}
    >
      <div
        style={{
          position: "relative",
          animationName: "shoal-bob",
          animationDuration: `${agent.bobDuration}s`,
          animationDelay: `${agent.bobDelay}s`,
          animationTimingFunction: "ease-in-out",
          animationIterationCount: "infinite",
          animationDirection: "alternate",
          animationFillMode: "both",
        }}
      >
        <div
          style={{
            animationName: "shoal-fade-in",
            animationDuration: "0.4s",
            animationTimingFunction: "ease-out",
            animationFillMode: "both",
          }}
        >
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.35rem",
              background: c.bg,
              border: `1px solid ${flashing ? c.dot + "88" : c.dot + "33"}`,
              borderRadius: "20px",
              padding: "4px 10px 4px 7px",
              whiteSpace: "nowrap",
              boxShadow: flashing
                ? `0 0 40px ${c.dot}cc, 0 0 18px ${c.dot}88, 0 2px 8px rgba(0,0,0,0.3)`
                : `0 0 16px ${c.glow}, 0 2px 8px rgba(0,0,0,0.3)`,
              transition: flashing ? "box-shadow 0.08s ease-in, border-color 0.08s ease-in" : "box-shadow 1.4s ease-out, border-color 1.4s ease-out",
              backdropFilter: "blur(4px)",
              cursor: "default",
              userSelect: "none",
            }}
          >
            <span
              style={{
                width: "6px",
                height: "6px",
                borderRadius: "50%",
                background: c.dot,
                flexShrink: 0,
                animationName: "shoal-pulse",
                animationDuration: "1.8s",
                animationTimingFunction: "ease-in-out",
                animationIterationCount: "infinite",
                animationFillMode: "both",
              }}
            />
            <span
              style={{
                fontSize: "0.6rem",
                fontWeight: 700,
                color: c.dot,
                fontFamily: "monospace",
                letterSpacing: "0.08em",
              }}
            >
              {TYPE_LABEL[agent.type]}
            </span>
            <span
              style={{
                fontSize: "0.75rem",
                fontWeight: 600,
                color: c.text,
                fontFamily: "monospace",
              }}
            >
              {agent.name}
            </span>
            <span
              style={{
                fontSize: "0.65rem",
                color: `${c.text}88`,
                fontFamily: "monospace",
              }}
            >
              {path}
            </span>
            {agent.findingsCount > 0 && (
              <span
                style={{
                  fontSize: "0.6rem",
                  fontWeight: 700,
                  color: "#fbbf24",
                  fontFamily: "monospace",
                  letterSpacing: "0.02em",
                }}
              >
                ⚡{agent.findingsCount}
              </span>
            )}
          </div>
        </div>
        {flashing && agent.lastFinding && (
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 5px)",
              left: 0,
              background: "rgba(251,191,36,0.12)",
              border: "1px solid #fbbf2455",
              borderRadius: "8px",
              padding: "2px 8px",
              fontSize: "0.6rem",
              color: "#fbbf24",
              fontFamily: "monospace",
              whiteSpace: "nowrap",
              pointerEvents: "none",
              animationName: "shoal-fade-in",
              animationDuration: "0.25s",
              animationTimingFunction: "ease-out",
              animationFillMode: "both",
            }}
          >
            ⚡ {agent.lastFinding.length > 34 ? agent.lastFinding.slice(0, 34) + "…" : agent.lastFinding}
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  container: {
    flex: 1,
    position: "relative" as const,
    background: "linear-gradient(180deg, #080f1e 0%, #0f172a 60%, #0b1220 100%)",
    overflow: "hidden",
    minHeight: "280px",
  },
  waterLayer: {
    position: "absolute" as const,
    inset: 0,
    backgroundImage: [
      "radial-gradient(ellipse at 20% 40%, rgba(59,130,246,0.04) 0%, transparent 55%)",
      "radial-gradient(ellipse at 75% 60%, rgba(34,197,94,0.04) 0%, transparent 55%)",
      "radial-gradient(ellipse at 50% 80%, rgba(249,115,22,0.03) 0%, transparent 40%)",
    ].join(", "),
    pointerEvents: "none" as const,
  },
  empty: {
    position: "absolute" as const,
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    color: "#1e293b",
    fontSize: "0.8rem",
    fontFamily: "monospace",
    textAlign: "center" as const,
    letterSpacing: "0.04em",
  },
  doneRow: {
    position: "absolute" as const,
    bottom: "0.75rem",
    left: 0,
    right: 0,
    display: "flex",
    gap: "0.5rem",
    justifyContent: "center",
    flexWrap: "wrap" as const,
    padding: "0 2rem",
  },
  doneBadge: {
    fontSize: "0.6rem",
    fontWeight: 600,
    fontFamily: "monospace",
    padding: "2px 8px",
    border: "1px solid",
    borderRadius: "12px",
    opacity: 0.45,
    letterSpacing: "0.04em",
  },
} as const;
