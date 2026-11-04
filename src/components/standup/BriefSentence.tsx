// The one sentence at the top of the Standup home: the page in brief. It
// draws the runs the view-model hands it and decides nothing: which clauses
// survive a failed read, and what each says, is `buildSentence`'s job.
import type { SentenceTone, SentenceView } from "@/lib/standup/view";
import styles from "./Standup.module.css";

function toneClass(tone: SentenceTone): string | undefined {
  if (tone === "hot") return styles.hot;
  if (tone === "clear") return styles.clear;
  return undefined;
}

export function BriefSentence({ sentence }: { readonly sentence: SentenceView }) {
  // Every clause failed: say nothing rather than an empty paragraph.
  if (sentence.parts.length === 0) return null;
  return (
    <p className={styles.brief}>
      {sentence.parts.map((part, index) =>
        part.tone === "plain" ? (
          <span key={index}>{part.text}</span>
        ) : (
          <strong key={index} className={toneClass(part.tone)} data-tone={part.tone}>
            {part.text}
          </strong>
        ),
      )}
    </p>
  );
}
