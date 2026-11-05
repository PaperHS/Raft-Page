import esbuild from 'esbuild';
const ctx = await esbuild.context({
  entryPoints: ['main.ts'], bundle: true, external: ['obsidian', 'electron'],
  format: 'cjs', target: 'es2022', platform: 'browser', outfile: 'main.js',
  sourcemap: false, logLevel: 'info',
});
if (process.argv.includes('--watch')) await ctx.watch();
else { await ctx.rebuild(); await ctx.dispose(); }
