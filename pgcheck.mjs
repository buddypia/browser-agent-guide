import { chromium } from '@playwright/test';
import path from 'node:path';
const browser = await chromium.launch();
const page = await browser.newPage();
const errs=[]; page.on('pageerror', e=>errs.push('PAGEERROR '+e.message));
page.on('console', m=>errs.push('CONSOLE '+m.type()+' '+m.text()));
try { await page.goto('file://'+path.resolve('test/fixtures/playground.html'), {waitUntil:'commit', timeout:6000}); } catch(e){ errs.push('GOTO '+e.message.split('\n')[0]); }
await new Promise(r=>setTimeout(r,2000));
let rs='?'; try{ rs = await page.evaluate(()=>document.readyState);}catch(e){rs='eval-fail:'+e.message.split('\n')[0];}
console.log('READYSTATE=' + rs);
console.log('ERRS=' + JSON.stringify(errs));
await browser.close();
