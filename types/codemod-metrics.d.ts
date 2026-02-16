declare module "codemod:metrics" {
  export type Cardinality = Record<string, string | undefined | null>;

  export interface MetricAtom {
    increment(cardinality?: Cardinality, amount?: number): void;
    getEntries(): Array<{ cardinality: Record<string, string>; count: number }>;
  }

  export function useMetricAtom(name: string): MetricAtom;
}
