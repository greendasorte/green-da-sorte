const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const htmlFiles = fs.readdirSync(root).filter((name) => name.endsWith(".html"));
const requiredPages = [
  "index.html",
  "jogos.html",
  "proximos.html",
  "palpites.html",
  "estatisticas.html",
  "campeonatos.html",
  "resultados.html"
];

let failures = 0;
function fail(message) {
  failures += 1;
  console.error("FAIL " + message);
}
function pass(message) {
  console.log("PASS " + message);
}

for (const page of requiredPages) {
  const file = path.join(root, page);
  if (!fs.existsSync(file)) {
    fail(page + " ausente");
    continue;
  }

  const source = fs.readFileSync(file, "utf8");
  if (!/<meta[^>]+name=["']viewport["'][^>]+>/.test(source)) {
    fail(page + " sem meta viewport");
  }
  if (!/@media\s*\(max-width:\s*760px\)/.test(source)) {
    fail(page + " sem regras mobile");
  }
  if (!/<body[^>]+data-page=["'][^"']+["']/.test(source)) {
    fail(page + " sem identificador data-page");
  }

  const scripts = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  if (scripts.length === 0) {
    fail(page + " sem JavaScript inline");
  }

  for (let index = 0; index < scripts.length; index += 1) {
    const code = scripts[index][1].trim();
    if (!code) continue;
    try {
      new vm.Script(code, { filename: page + ":script-" + (index + 1) });
    } catch (error) {
      fail(page + " script " + (index + 1) + ": " + error.message);
    }
  }

  if (failures === 0) pass(page + " estrutura e JavaScript verificados");
}

for (const file of ["server.js", "sportsapi.js"]) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  try {
    new vm.Script(source, { filename: file });
    pass(file + " sintaxe JavaScript verificada");
  } catch (error) {
    fail(file + ": " + error.message);
  }
}

if (failures > 0) {
  console.error("\n" + failures + " verificação(ões) falharam.");
  process.exit(1);
}
console.log("\nValidação estática concluída.");
