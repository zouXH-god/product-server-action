const core = require('@actions/core')
const glob = require('@actions/glob')
const archiver = require('archiver')
const FormData = require('form-data')
const crypto = require('crypto')
const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const os = require('os')

function resolveVersion(override, env = process.env) {
  if (override && override.trim()) return override.trim()
  if (env.GITHUB_REF_TYPE === 'tag' && env.GITHUB_REF_NAME) return env.GITHUB_REF_NAME
  if (env.GITHUB_SHA) return env.GITHUB_SHA
  throw new Error('version is required outside GitHub Actions')
}
function resolveBranch(env = process.env) {
  if (env.GITHUB_HEAD_REF && env.GITHUB_HEAD_REF.trim()) return env.GITHUB_HEAD_REF.trim()
  if (env.GITHUB_REF_TYPE === 'branch' && env.GITHUB_REF_NAME) return env.GITHUB_REF_NAME.trim()
  if (env.GITHUB_REF && env.GITHUB_REF.startsWith('refs/heads/')) return env.GITHUB_REF.slice('refs/heads/'.length)
  if (env.CI_COMMIT_BRANCH && env.CI_COMMIT_BRANCH.trim()) return env.CI_COMMIT_BRANCH.trim()
  return ''
}
function normalizeName(value) {
  let name = (value || 'artifact.zip').trim()
  if (!name.toLowerCase().endsWith('.zip')) name += '.zip'
  if (!name || name === '.zip' || path.basename(name) !== name || /[\\/\0]/.test(name)) throw new Error('name must be a plain ZIP file name')
  return name
}
async function collectFiles(input, workspace) {
  const patterns = input.split(/\r?\n/).map(v => v.trim()).filter(Boolean)
  if (!patterns.length) throw new Error('path must contain at least one pattern')
  const expanded = []
  for (const pattern of patterns) {
    const absolute = path.resolve(workspace, pattern)
    try { if ((await fsp.stat(absolute)).isDirectory()) { expanded.push(path.join(absolute, '**')); continue } } catch (_) {}
    expanded.push(absolute)
  }
  const globber = await glob.create(expanded.join('\n'), { followSymbolicLinks: false, implicitDescendants: true })
  const matches = await globber.glob()
  const files = []
  for (const file of matches) {
    const stat = await fsp.stat(file)
    if (stat.isFile()) files.push(path.resolve(file))
  }
  const unique = [...new Set(files)].sort((a,b) => path.relative(workspace,a).replaceAll('\\','/').localeCompare(path.relative(workspace,b).replaceAll('\\','/')))
  if (!unique.length) throw new Error('path did not match any files')
  for (const file of unique) if (path.relative(workspace, file).startsWith('..')) throw new Error(`matched file is outside GITHUB_WORKSPACE: ${file}`)
  return unique
}
async function createDeterministicZip(files, workspace, output) {
  await fsp.mkdir(path.dirname(output), { recursive: true })
  const stream = fs.createWriteStream(output)
  const archive = archiver('zip', { zlib: { level: 9 } })
  const done = new Promise((resolve, reject) => { stream.on('close', resolve); stream.on('error', reject); archive.on('error', reject) })
  archive.pipe(stream)
  for (const file of files) archive.file(file, { name: path.relative(workspace,file).replaceAll('\\','/'), date: new Date(0), mode: 0o644 })
  await archive.finalize(); await done
  const hash = crypto.createHash('sha256')
  await new Promise((resolve,reject) => fs.createReadStream(output).on('data',d=>hash.update(d)).on('end',resolve).on('error',reject))
  return hash.digest('hex')
}
async function upload(baseURL, token, zipPath, filename, fields) {
  const endpoint = new URL('/api/upload', baseURL.replace(/\/+$/, '') + '/')
  const stat = await fsp.stat(zipPath)
  const form = new FormData()
  for (const [key,value] of Object.entries(fields)) if (value) form.append(key, value)
  form.append('files', fs.createReadStream(zipPath), { filename, contentType: 'application/zip', knownLength: stat.size })
  return new Promise((resolve,reject) => {
    const request = form.submit({ protocol:endpoint.protocol, host:endpoint.hostname, port:endpoint.port, path:endpoint.pathname, method:'POST', headers:{Authorization:`Bearer ${token}`}}, (error, response) => {
      if (error) { reject(error); return }
      let body=''; response.setEncoding('utf8'); response.on('data',chunk=>body+=chunk); response.on('end',()=>{
        let data={}; try{data=body?JSON.parse(body):{}}catch(_){}
        if(response.statusCode===200||response.statusCode===201) resolve({status:response.statusCode,data})
        else reject(new Error(data?.error?.message || `upload failed (${response.statusCode}): ${body}`))
      })
    })
    request.on('error', reject)
  })
}
async function run() {
  const token=core.getInput('token',{required:true}); core.setSecret(token)
  const baseURL=core.getInput('url',{required:true}); const version=resolveVersion(core.getInput('version'))
  const filename=normalizeName(core.getInput('name')); const workspace=process.env.GITHUB_WORKSPACE||process.cwd()
  const tempRoot=await fsp.mkdtemp(path.join(process.env.RUNNER_TEMP||os.tmpdir(),'productserver-'))
  const zipPath=path.join(tempRoot,filename)
  try {
    const files=await collectFiles(core.getInput('path',{required:true}),workspace)
    core.info(`Packaging ${files.length} file(s) as ${filename}`)
    const sha256=await createDeterministicZip(files,workspace,zipPath)
    const serverURL=baseURL.replace(/\/+$/,'')
    const branch=resolveBranch()
    await upload(serverURL,token,zipPath,filename,{version,ref_type:process.env.GITHUB_REF_TYPE==='tag'?'tag':'commit',commit_sha:process.env.GITHUB_SHA||'',branch,pipeline_id:process.env.GITHUB_RUN_ID||'',job_url:process.env.GITHUB_SERVER_URL&&process.env.GITHUB_REPOSITORY&&process.env.GITHUB_RUN_ID?`${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`:''})
    const downloadURL=`${serverURL}/api/download?version=${encodeURIComponent(version)}&file=${encodeURIComponent(filename)}`
    core.setOutput('version',version);core.setOutput('branch',branch);core.setOutput('file',filename);core.setOutput('sha256',sha256);core.setOutput('download-url',downloadURL)
    core.info(`Uploaded ${filename} (${sha256})`)
  } finally { await fsp.rm(tempRoot,{recursive:true,force:true}) }
}
if (require.main === module) run().catch(error=>core.setFailed(error instanceof Error?error.message:String(error)))
module.exports={resolveVersion,resolveBranch,normalizeName,collectFiles,createDeterministicZip,upload}
