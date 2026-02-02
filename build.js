const fs = require("fs");
const path = require("path");
const { minify } = require("html-minifier-terser");

const srcDir = path.join(__dirname, "src");
const outFile = path.join(__dirname, "public", "index.html");

const html = fs.readFileSync(path.join(srcDir, "index.html"), "utf8");
const css = fs.readFileSync(path.join(srcDir, "style.css"), "utf8");
const js = fs.readFileSync(path.join(srcDir, "app.js"), "utf8");

const inlined = html
  .replace(
    '<link rel="stylesheet" href="style.css" />',
    "<style>\n" + css + "</style>",
  )
  .replace('<script src="app.js"></script>', "<script>\n" + js + "</script>");

async function build() {
  const output = await minify(inlined, {
    collapseWhitespace: true,
    removeComments: true,
    minifyCSS: true,
    minifyJS: true,
  });

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, output);

  const size = (fs.statSync(outFile).size / 1024).toFixed(1);
  console.log(`Built ${outFile} (${size} KB)`);
}

build();
