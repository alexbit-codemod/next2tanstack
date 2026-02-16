/// <reference path="./codemod-metrics.d.ts" />
import type { Edit, SgRoot } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";

export type SubTranform = (root: SgRoot<TSX>) => Promise<Edit[] | null>;
