import { useEffect, useState } from "react";
import type { RoleDefinitionV1 } from "@werewolf/contracts";
import { api } from "../api";

interface Props {
  roles: RoleDefinitionV1[];
  onSaved(): void;
}

export function RoleLab({ roles, onSaved }: Props) {
  const [selected, setSelected] = useState<RoleDefinitionV1 | undefined>(roles[0]);
  const [source, setSource] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!selected && roles[0]) setSelected(roles[0]);
  }, [roles, selected]);

  useEffect(() => {
    if (selected) setSource(JSON.stringify(selected, null, 2));
  }, [selected]);

  async function save() {
    setMessage("");
    try {
      const parsed = JSON.parse(source) as RoleDefinitionV1;
      const saved = await api.createRole(parsed);
      setSelected(saved);
      setMessage(`Saved immutable version ${saved.version}.`);
      onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section className="workspace role-layout">
      <aside className="panel role-index">
        <div className="eyebrow">Declarative library</div>
        <h2>Roles</h2>
        {roles.map((role) => (
          <button
            className={selected?.id === role.id && selected.version === role.version ? "role-link active" : "role-link"}
            key={`${role.id}:${role.version}`}
            onClick={() => setSelected(role)}
          >
            <span className={`alignment-dot ${role.alignment}`} />
            <span>{role.name}</span>
            <small>v{role.version}</small>
          </button>
        ))}
      </aside>
      <div className="panel editor-panel">
        <div className="editor-heading">
          <div>
            <div className="eyebrow">Restricted role_v1 AST</div>
            <h2>Role workshop</h2>
          </div>
          <button className="primary" onClick={save}>Save new version</button>
        </div>
        <p className="muted">Descriptions influence play, but only validated actions, effects, targets, passives, and predicates influence rules.</p>
        <textarea className="code-editor" spellCheck={false} value={source} onChange={(event) => setSource(event.target.value)} />
        {message && <div className={message.startsWith("Saved") ? "success-banner" : "error-banner"}>{message}</div>}
      </div>
    </section>
  );
}
