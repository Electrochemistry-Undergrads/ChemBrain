import { synthesisSegments } from '../../shared/synthesis';

export function SynthesisText({ text, names = [] }: { text: string; names?: string[] }) {
  return <>{synthesisSegments(text, names).map((part, i) => part.bold ? <strong key={i}>{part.text}</strong> : part.text)}</>;
}
