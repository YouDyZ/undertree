import { useEffect, useState } from "preact/hooks";
import {
  type SpellDictionary,
  deleteDictionaryWord,
  errorText,
  getDictionary,
  setDisabledRules,
} from "../api";
import {
  type HunspellLangChoice,
  SPELL_PROVIDERS,
  type SpellProvider,
  getHunspellLang,
  getSpellProvider,
  isLanguageToolDisabled,
  notifyDictionaryChanged,
  setHunspellLang,
  setSpellProvider,
} from "../editor/spellcheck";
import {
  getBrowserSpellcheckEnabled,
  setBrowserSpellcheckEnabled,
} from "../editor/browserSpellcheck";
import { TrashIcon } from "./Icons";

/** "Rechtschreibprüfung" in the project settings: provider (per user), dictionary, ignored rules. */
export function SpellcheckSettings({
  projectId,
  canEdit = true,
}: {
  projectId: number;
  canEdit?: boolean;
}) {
  const [provider, setProvider] = useState<SpellProvider>(getSpellProvider);
  const [lang, setLang] = useState<HunspellLangChoice>(getHunspellLang);
  const [browserExt, setBrowserExt] = useState<boolean>(getBrowserSpellcheckEnabled);
  const [dict, setDict] = useState<SpellDictionary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDictionary(projectId)
      .then(setDict)
      .catch((err: unknown) => setError(errorText(err, "Wörterbuch konnte nicht geladen werden.")));
  }, [projectId]);

  const removeWord = (word: string) =>
    deleteDictionaryWord(word, projectId)
      .then(() => {
        setDict((d) => d && { ...d, words: d.words.filter((w) => w !== word) });
        notifyDictionaryChanged();
      })
      .catch((err: unknown) => setError(errorText(err, "Entfernen fehlgeschlagen.")));

  const removeRule = (rule: string) =>
    setDisabledRules(dict?.disabled_rules.filter((r) => r !== rule) ?? [], projectId)
      .then((res) => {
        setDict((d) => d && { ...d, disabled_rules: res.disabled_rules });
        notifyDictionaryChanged();
      })
      .catch((err: unknown) => setError(errorText(err, "Entfernen fehlgeschlagen.")));

  const list = (items: string[], empty: string, remove: (item: string) => void, label: string) =>
    items.length === 0 ? (
      <span class="muted-text">{empty}</span>
    ) : (
      <ul class="member-list">
        {items.map((item) => (
          <li key={item}>
            <span class="mono">{item}</span>
            {canEdit && (
              <button
                type="button"
                class="icon-btn icon-btn-danger"
                title="Entfernen"
                aria-label={`${label} ${item} entfernen`}
                onClick={() => remove(item)}
              >
                <TrashIcon size={13} />
              </button>
            )}
          </li>
        ))}
      </ul>
    );

  return (
    <section class="settings-section form-stack">
      <h3>Rechtschreibprüfung</h3>
      {error && <div class="alert alert-error" role="alert">{error}</div>}
      <select
        class="text-input"
        value={provider}
        aria-label="Rechtschreibprüfung"
        onChange={(e) => {
          const next = (e.target as HTMLSelectElement).value as SpellProvider;
          setSpellProvider(next);
          setProvider(next);
        }}
      >
        {SPELL_PROVIDERS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      {provider === "hunspell" && (
        <select
          class="text-input"
          value={lang ?? ""}
          aria-label="Sprache des Hunspell-Wörterbuchs"
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            const next = v === "de" || v === "en" ? v : null;
            setHunspellLang(next);
            setLang(next);
          }}
        >
          <option value="">Sprache automatisch (aus dem TeX, sonst Englisch)</option>
          <option value="de">Deutsch</option>
          <option value="en">Englisch</option>
        </select>
      )}
      <span class="field-hint">
        {isLanguageToolDisabled()
          ? "LanguageTool ist auf diesem Server nicht eingerichtet."
          : "Gilt für dich in diesem Browser. Die Sprache kommt aus dem TeX (babel, polyglossia, % !TeX spellcheck)."}
      </span>
      <label class="check-field">
        <input
          type="checkbox"
          checked={browserExt}
          onChange={(e) => {
            const next = (e.target as HTMLInputElement).checked;
            setBrowserSpellcheckEnabled(next);
            setBrowserExt(next);
          }}
        />
        <span>Browser-Erweiterungen (z. B. LanguageTool) erlauben</span>
      </label>
      <span class="field-hint">
        Aktiviert die Browser-Rechtschreibung im Editor, damit Erweiterungen wie LanguageTool das
        Textfeld erkennen. Datenschutz: Die kostenlose LanguageTool-Erweiterung sendet den
        bearbeiteten Text an LanguageTool-Server (bei unveröffentlichten Papern beachten).
      </span>
      {browserExt && provider !== "off" && (
        <div class="field-hint">
          <span>
            Hinweis: Eingebaute Prüfung und Browser-Erweiterungen sind gleichzeitig aktiv — das kann
            zu doppelten Unterstreichungen führen.{" "}
          </span>
          <button
            type="button"
            class="btn-ghost btn-xs"
            onClick={() => {
              setSpellProvider("off");
              setProvider("off");
            }}
          >
            Eingebaute Prüfung ausschalten
          </button>
        </div>
      )}
      {dict && (
        <>
          <span class="field-hint">Wörterbuch (für alle Mitglieder)</span>
          {list(dict.words, "Noch keine Wörter.", (w) => void removeWord(w), "Wort")}
          <span class="field-hint">Ignorierte Regeln</span>
          {list(dict.disabled_rules, "Keine.", (r) => void removeRule(r), "Regel")}
        </>
      )}
    </section>
  );
}
