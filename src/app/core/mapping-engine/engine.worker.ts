/// <reference lib="webworker" />
import { EngineInput, executeMappings } from './engine';

/** Executa o motor fora da thread principal: dados grandes e regex lentas não travam a interface. */
addEventListener('message', (event: MessageEvent<{ id: number; input: EngineInput }>) => {
  const { id, input } = event.data;
  try {
    postMessage({ id, result: executeMappings(input) });
  } catch (e) {
    postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
});
