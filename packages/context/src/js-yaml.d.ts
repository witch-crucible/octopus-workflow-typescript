/** js-yaml 运行时模块的最小类型声明，避免配置解析退化为隐式 any。 */
declare module "js-yaml" {
  export function load(source: string): unknown
  export function dump(value: unknown): string
}
