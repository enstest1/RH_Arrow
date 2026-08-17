# Ohio server: pre-set scripts (recommended over auto-spin-up)

## Why pre-set, not "give the bot AWS access"
The closest location is not a mystery to compute — it's always AWS us-east-2 (Ohio),
where the RH sequencer lives. So there's nothing to auto-decide. And giving any bot
standing keys to create AWS infrastructure is a real risk (leaked keys = someone
runs up huge bills on your account). These scripts instead use YOUR existing AWS CLI
login. No keys live in this project. Nothing is pasted into a chat.

## ⚠️ Never paste AWS Access Key + Secret into a chat window
If any tool asks you to paste your AWS keys into a message, decline. Keys go into the
AWS CLI's own secure store on your machine (below), never into a chat or into code.

## One-time AWS login (on your machine)
Install the AWS CLI, then authenticate ONCE. Two options:

Option 1 — access keys (simplest):
  1. AWS Console -> IAM -> Users -> your user -> Security credentials -> Create access key.
  2. Run:  aws configure
     Paste the Access Key ID and Secret Access Key at the prompts (this stores them
     encrypted in ~/.aws, used only by the AWS CLI — NOT in any chat or file of ours).
     Set default region: us-east-2

Option 2 — SSO (preferred if your org uses it, no long-lived keys):
     aws sso login

Verify:  aws sts get-caller-identity   (should print your account/ARN)

## Launch the Ohio box (one command)
From the project folder:
    ./deploy/launch-ohio.sh
It checks your login, creates an SSH key pair + a security group locked to YOUR IP,
finds the latest Ubuntu, launches a t3.micro in Ohio, and prints the IP + next steps.

## Put the minter on it, run it safely
    scp -i rh-minter-key.pem -r . ubuntu@THE_IP:~/rh-minter
    ssh -i rh-minter-key.pem ubuntu@THE_IP
    # on the box:
    ./deploy/provision-on-box.sh      # installs Node + deps
    nano .env                         # your keys live HERE, on the box, not public
    npm run ui                        # binds localhost on the box
    # from your laptop, view it privately over an SSH tunnel:
    ssh -i rh-minter-key.pem -L 4663:localhost:4663 ubuntu@THE_IP
    # open http://localhost:4663

The tunnel means the dashboard is NEVER exposed to the internet — safest option.

## Stop paying when done
    ./deploy/terminate-ohio.sh
(Or EC2 console -> select instance -> Terminate.)

## Optional: preset without any of this
If you don't want AWS at all, Railway (US East = Virginia, near Ohio) is the
one-click path — see ../DEPLOY.md Option A. Less optimal latency, far less setup.
