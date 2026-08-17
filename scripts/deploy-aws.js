/**
 * Launch an EC2 instance in us-east-2 (Ohio) for rh-minter.
 * Uses AWS SDK — no AWS CLI required.
 *
 * Prerequisites (one of):
 *   - AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY env vars
 *   - ~/.aws/credentials (run: aws configure)
 *
 * Usage:
 *   node scripts/deploy-aws.js
 *   node scripts/deploy-aws.js --setup   # also SCP project + run remote setup
 */

import {
  EC2Client,
  DescribeImagesCommand,
  DescribeSecurityGroupsCommand,
  CreateKeyPairCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  RunInstancesCommand,
  DescribeInstancesCommand,
  waitUntilInstanceRunning,
} from '@aws-sdk/client-ec2';
import { fromEnv, fromIni } from '@aws-sdk/credential-providers';
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** Ohio — Robinhood Chain sequencer region per DEPLOY.md */
const REGION = 'us-east-2';
const INSTANCE_TYPE = 't3.micro';
const KEY_NAME = 'rh-minter-key';
const SG_NAME = 'rh-minter-sg';
const KEY_DIR = path.join(ROOT, '.aws-keys');
const KEY_PATH = path.join(KEY_DIR, `${KEY_NAME}.pem`);

const DO_SETUP = process.argv.includes('--setup');

/**
 * Resolve AWS credentials from env vars or shared credentials file.
 */
function makeClient() {
  const hasEnv = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY;
  const credentials = hasEnv ? fromEnv() : fromIni({ profile: process.env.AWS_PROFILE || 'default' });
  return new EC2Client({ region: REGION, credentials });
}

/**
 * Fetch caller public IP for SSH security group rule (My IP only).
 */
async function getMyPublicIp() {
  const res = await fetch('https://checkip.amazonaws.com');
  if (!res.ok) throw new Error(`Could not detect public IP: ${res.status}`);
  return (await res.text()).trim();
}

/**
 * Latest Ubuntu 22.04 LTS AMI in us-east-2 (Canonical owner).
 */
async function findUbuntuAmi(ec2) {
  const { Images } = await ec2.send(new DescribeImagesCommand({
    Owners: ['099720109477'],
    Filters: [
      { Name: 'name', Values: ['ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*'] },
      { Name: 'state', Values: ['available'] },
      { Name: 'architecture', Values: ['x86_64'] },
    ],
  }));
  if (!Images?.length) throw new Error('No Ubuntu 22.04 AMI found in us-east-2');
  Images.sort((a, b) => new Date(b.CreationDate) - new Date(a.CreationDate));
  return Images[0].ImageId;
}

/**
 * Create or reuse SSH key pair; save .pem locally (gitignored).
 */
async function ensureKeyPair(ec2) {
  mkdirSync(KEY_DIR, { recursive: true });
  if (existsSync(KEY_PATH)) {
    console.log(`Using existing key: ${KEY_PATH}`);
    return KEY_NAME;
  }
  const { KeyMaterial } = await ec2.send(new CreateKeyPairCommand({ KeyName: KEY_NAME }));
  writeFileSync(KEY_PATH, KeyMaterial, { mode: 0o400 });
  try { chmodSync(KEY_PATH, 0o400); } catch { /* Windows may ignore */ }
  console.log(`Saved new key pair: ${KEY_PATH}`);
  return KEY_NAME;
}

/**
 * Security group: SSH (22) from caller IP only — no public UI port.
 */
async function ensureSecurityGroup(ec2, myIp) {
  let groupId;
  try {
    const { GroupId } = await ec2.send(new CreateSecurityGroupCommand({
      GroupName: SG_NAME,
      Description: 'rh-minter: SSH from deployer IP only',
    }));
    groupId = GroupId;
    await ec2.send(new AuthorizeSecurityGroupIngressCommand({
      GroupId: groupId,
      IpPermissions: [{
        IpProtocol: 'tcp',
        FromPort: 22,
        ToPort: 22,
        IpRanges: [{ CidrIp: `${myIp}/32`, Description: 'Deployer SSH' }],
      }],
    }));
    console.log(`Created security group ${SG_NAME} (${groupId}) — SSH from ${myIp}/32`);
  } catch (err) {
    if (err.name === 'InvalidGroup.Duplicate') {
      // Re-use existing group; add ingress for current IP if needed
      const desc = await ec2.send(new DescribeSecurityGroupsCommand({
        Filters: [{ Name: 'group-name', Values: [SG_NAME] }],
      }));
      groupId = desc.SecurityGroups?.[0]?.GroupId;
      if (!groupId) throw new Error(`Security group ${SG_NAME} exists but could not resolve GroupId`);
      try {
        await ec2.send(new AuthorizeSecurityGroupIngressCommand({
          GroupId: groupId,
          IpPermissions: [{
            IpProtocol: 'tcp',
            FromPort: 22,
            ToPort: 22,
            IpRanges: [{ CidrIp: `${myIp}/32`, Description: 'Deployer SSH' }],
          }],
        }));
        console.log(`Updated ${SG_NAME} — added SSH from ${myIp}/32`);
      } catch (e) {
        if (e.name !== 'InvalidPermission.Duplicate') throw e;
        console.log(`Security group ${SG_NAME} already allows SSH (or duplicate rule)`);
      }
    } else {
      throw err;
    }
  }
  return groupId;
}

/**
 * Launch t3.micro Ubuntu instance tagged for easy cleanup.
 */
async function launchInstance(ec2, { amiId, keyName, groupId }) {
  const { Instances } = await ec2.send(new RunInstancesCommand({
    ImageId: amiId,
    InstanceType: INSTANCE_TYPE,
    KeyName: keyName,
    MinCount: 1,
    MaxCount: 1,
    SecurityGroupIds: [groupId],
    BlockDeviceMappings: [{
      DeviceName: '/dev/sda1',
      Ebs: { VolumeSize: 8, VolumeType: 'gp3', DeleteOnTermination: true },
    }],
    TagSpecifications: [{
      ResourceType: 'instance',
      Tags: [
        { Key: 'Name', Value: 'rh-minter' },
        { Key: 'Project', Value: 'rh-minter' },
      ],
    }],
  }));
  return Instances[0].InstanceId;
}

/**
 * Poll until instance has a public IP.
 */
async function waitForPublicIp(ec2, instanceId) {
  await waitUntilInstanceRunning({ client: ec2, maxWaitTime: 300 }, { InstanceIds: [instanceId] });
  for (let i = 0; i < 30; i++) {
    const { Reservations } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const inst = Reservations?.[0]?.Instances?.[0];
    const ip = inst?.PublicIpAddress;
    if (ip) return ip;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('Instance running but no public IP yet');
}

/**
 * Copy project + .env to server and run bootstrap script over SSH.
 */
function remoteSetup(publicIp) {
  const sshBase = `ssh -i "${KEY_PATH}" -o StrictHostKeyChecking=accept-new ubuntu@${publicIp}`;
  const scpBase = `scp -i "${KEY_PATH}" -o StrictHostKeyChecking=accept-new`;

  console.log('\nWaiting 30s for SSH daemon...');
  execSync('sleep 30', { stdio: 'inherit' });

  // Upload project (exclude node_modules — installed on server)
  const parent = path.dirname(ROOT);
  const folder = path.basename(ROOT);
  execSync(
    `${scpBase} -r "${ROOT}/package.json" "${ROOT}/package-lock.json" "${ROOT}/src" "${ROOT}/scripts" ubuntu@${publicIp}:~/rh-minter-tmp/`,
    { stdio: 'inherit', shell: true },
  );

  // Upload .env if present (never committed)
  const envPath = path.join(ROOT, '.env');
  if (existsSync(envPath)) {
    execSync(`${scpBase} "${envPath}" ubuntu@${publicIp}:~/rh-minter-tmp/.env`, { stdio: 'inherit', shell: true });
  } else {
    console.warn('No local .env found — you must create one on the server');
  }

  execSync(
    `${sshBase} "bash -s" < "${path.join(__dirname, 'remote-setup.sh')}"`,
    { stdio: 'inherit', shell: true },
  );
}

async function main() {
  if (!process.env.AWS_ACCESS_KEY_ID && !existsSync(path.join(process.env.USERPROFILE || process.env.HOME || '', '.aws', 'credentials'))) {
    console.error(`
AWS credentials not found.

Option 1 — set env vars (recommended for this script):
  export AWS_ACCESS_KEY_ID=AKIA...
  export AWS_SECRET_ACCESS_KEY=...

Option 2 — AWS CLI configure (creates ~/.aws/credentials):
  aws configure

Get keys from: AWS Console -> IAM -> Users -> Security credentials -> Create access key
`);
    process.exit(1);
  }

  const ec2 = makeClient();
  const myIp = await getMyPublicIp();
  console.log(`Region: ${REGION} | Your IP: ${myIp}`);

  const amiId = await findUbuntuAmi(ec2);
  console.log(`AMI: ${amiId}`);

  const keyName = await ensureKeyPair(ec2);
  const groupId = await ensureSecurityGroup(ec2, myIp);

  console.log('Launching instance...');
  const instanceId = await launchInstance(ec2, { amiId, keyName, groupId });
  console.log(`InstanceId: ${instanceId}`);

  const publicIp = await waitForPublicIp(ec2, instanceId);
  console.log(`\n=== rh-minter EC2 ready ===`);
  console.log(`Public IP: ${publicIp}`);
  console.log(`Key file:  ${KEY_PATH}`);
  console.log(`
SSH in:
  ssh -i "${KEY_PATH}" ubuntu@${publicIp}

Copy project (from laptop):
  scp -i "${KEY_PATH}" -r ./rh-minter ubuntu@${publicIp}:~

SSH tunnel for UI (run on laptop, keep open):
  ssh -i "${KEY_PATH}" -L 4663:localhost:4663 ubuntu@${publicIp}

On the server:
  cd rh-minter && npm install && npm run ui
Then open http://localhost:4663 on your laptop.

Terminate when done (AWS Console -> EC2 -> Terminate):
  InstanceId ${instanceId}
`);

  if (DO_SETUP) {
    remoteSetup(publicIp);
    console.log('\nRemote setup complete. Start tunnel + open http://localhost:4663');
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
