const fs=require('fs');
const os=require('os');
const path=require('path');
const assert=require('assert');
const base=fs.mkdtempSync(path.join(os.tmpdir(),'alone-v7425-'));
process.env.ALONE_BASE_DIR=base;
const settings=require('../codigo-fonte-dev/server/settings');
const schedule={0:[[540,720]],1:[[390,690],[870,1290]],2:[[390,690],[870,1290]],3:[[390,690],[870,1290]],4:[[390,690],[870,1290]],5:[[390,690],[870,1290]],6:[[510,750]]};
const saved=settings.saveSettings({businessSchedule:schedule,businessTimezone:'America/Sao_Paulo'});
assert.deepStrictEqual(saved.businessSchedule,schedule);
const reloaded=settings.loadSettings();
assert.deepStrictEqual(reloaded.businessSchedule,schedule);
const before=JSON.stringify(reloaded.businessSchedule);
let failed=false;
try{settings.saveSettings({businessSchedule:{0:[[0,0]],1:[[360,660]],2:[[360,660]],3:[[360,660]],4:[[360,660]],5:[[360,660]],6:[[480,720]]}});}catch(e){failed=true;assert(/Horário inválido/.test(e.message));}
assert(failed,'Agenda inválida deveria ser recusada');
assert.strictEqual(JSON.stringify(settings.loadSettings().businessSchedule),before,'Agenda válida anterior deve permanecer intacta');
console.log('Smoke v7.4.25 OK');
