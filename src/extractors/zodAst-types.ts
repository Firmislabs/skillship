import { CallExpression, Node } from "ts-morph";

export interface ZodTypeInfo {
  readonly type: string;
  readonly required: boolean;
}

export function analyseZodChain(call: CallExpression): ZodTypeInfo {
  const methods = collectChainMethods(call);
  const required = !methods.includes("optional");
  const baseMethod = methods[methods.length - 1] ?? "unknown";
  return { type: zodMethodToType(baseMethod), required };
}

function collectChainMethods(call: CallExpression): string[] {
  const out: string[] = [];
  let current: Node | undefined = call;
  while (Node.isCallExpression(current)) {
    const expr = current.getExpression();
    if (Node.isPropertyAccessExpression(expr)) {
      out.push(expr.getName());
      current = expr.getExpression();
    } else {
      break;
    }
  }
  return out;
}

function zodMethodToType(method: string): string {
  switch (method) {
    case "string":
    case "enum":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return "array";
    case "object":
      return "object";
    default:
      return "unknown";
  }
}
