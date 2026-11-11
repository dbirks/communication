{{/*
Naming and labels.
*/}}
{{- define "communication.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "communication.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "communication.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "communication.labels" -}}
helm.sh/chart: {{ include "communication.chart" . }}
{{ include "communication.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: communication
{{- end -}}

{{- define "communication.selectorLabels" -}}
app.kubernetes.io/name: {{ include "communication.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Component labels (serve / worker / single), so the Service selects exactly the
Deployment that answers HTTP.
*/}}
{{- define "communication.componentLabels" -}}
{{ include "communication.labels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "communication.componentSelectorLabels" -}}
{{ include "communication.selectorLabels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/*
Images. `image` is the worker image (single mode + the worker Deployment);
`serveImage` is the control-plane image (split-mode serve only). An empty tag
means Chart.appVersion; never float a tag you intend to `kind load`.
*/}}
{{- define "communication.workerImage" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}

{{- define "communication.serveImage" -}}
{{- $tag := .Values.serveImage.tag | default .Values.image.tag | default .Chart.AppVersion -}}
{{- printf "%s:%s" .Values.serveImage.repository $tag -}}
{{- end -}}

{{- define "communication.serveImagePullPolicy" -}}
{{- .Values.serveImage.pullPolicy | default .Values.image.pullPolicy -}}
{{- end -}}

{{/*
One-shot image. Single mode deliberately reuses the worker image, so the whole
`communication dev` pod pulls exactly one image; split mode uses the cheap
control-plane image for its initContainers.
*/}}
{{- define "communication.initImage" -}}
{{- if eq .Values.mode "single" -}}{{ include "communication.workerImage" . }}{{- else -}}{{ include "communication.serveImage" . }}{{- end -}}
{{- end -}}

{{- define "communication.initImagePullPolicy" -}}
{{- if eq .Values.mode "single" -}}{{ .Values.image.pullPolicy }}{{- else -}}{{ include "communication.serveImagePullPolicy" . }}{{- end -}}
{{- end -}}

{{/*
True only in split mode with launcher: kubernetes — the sole switch that makes
RBAC and NetworkPolicy render (ADR-0082 Decision 6/7).
*/}}
{{- define "communication.podLauncher" -}}
{{- if and (eq .Values.mode "split") (eq .Values.worker.launcher "kubernetes") -}}true{{- end -}}
{{- end -}}

{{/*
The worker ServiceAccount name; only rendered with the pod launcher.
*/}}
{{- define "communication.workerSA" -}}
{{ printf "%s-worker" (include "communication.fullname" .) }}
{{- end -}}

{{/*
Values that would render a broken or over-privileged deployment.
*/}}
{{- define "communication.validate" -}}
{{- if not (has .Values.mode (list "single" "split")) -}}
{{- fail (printf "mode must be single or split, got %q" .Values.mode) -}}
{{- end -}}
{{- if not (has .Values.worker.enforcement (list "required" "permissive-dev" "disabled")) -}}
{{- fail (printf "worker.enforcement must be required, permissive-dev or disabled, got %q" .Values.worker.enforcement) -}}
{{- end -}}
{{- if not (has .Values.worker.launcher (list "local" "kubernetes")) -}}
{{- fail (printf "worker.launcher must be local or kubernetes, got %q" .Values.worker.launcher) -}}
{{- end -}}
{{- if and (eq .Values.mode "single") (ne .Values.worker.launcher "local") -}}
{{- fail "mode single never grants pod-creation rights: worker.launcher must be local (use mode split for the kubernetes launcher)" -}}
{{- end -}}
{{- if and (eq .Values.mode "split") (eq .Values.worker.launcher "kubernetes") (not .Values.worker.agentNamespace) -}}
{{- fail "worker.agentNamespace is required when worker.launcher=kubernetes" -}}
{{- end -}}
{{- if and (.Values.publicUrl) (not (hasPrefix "://" (printf "://%s" (.Values.publicUrl | trimPrefix "http://" | trimPrefix "https://")))) -}}
{{- fail (printf "publicUrl must be an absolute URL, got %q" .Values.publicUrl) -}}
{{- end -}}
{{- if and (.Values.oidc.issuer) (not .Values.oidc.clientId) -}}
{{- fail "oidc.clientId is required when oidc.issuer is set" -}}
{{- end -}}
{{- if and (.Values.oidc.clientSecret.name) (not .Values.oidc.clientSecret.key) -}}
{{- fail "oidc.clientSecret.key is required when oidc.clientSecret.name is set" -}}
{{- end -}}
{{- if not .Values.database.urlSecret.name -}}
{{- fail "database.urlSecret.name must name the Secret holding the database URL" -}}
{{- end -}}
{{- if not .Values.database.urlSecret.key -}}
{{- fail "database.urlSecret.key must name the key holding the database URL" -}}
{{- end -}}
{{- if .Values.keyringSecret -}}
{{- if not (regexMatch "^[A-Za-z0-9._-]+$" .Values.keyringSecret) -}}
{{- fail (printf "keyringSecret must be a Secret name, got %q" .Values.keyringSecret) -}}
{{- end -}}
{{- end -}}
{{- if and .Values.ingress.enabled (not .Values.ingress.host) -}}
{{- fail "ingress.host is required when ingress.enabled" -}}
{{- end -}}
{{- end -}}

{{/*
Environment every Communication container needs. Only names, keys and fieldRefs
— never a secret value.
*/}}
{{- define "communication.envCommon" -}}
- name: COMMUNICATION_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.database.urlSecret.name }}
      key: {{ .Values.database.urlSecret.key }}
{{- if .Values.publicUrl }}
- name: COMMUNICATION_PUBLIC_URL
  value: {{ .Values.publicUrl | quote }}
{{- end }}
{{- if .Values.oidc.issuer }}
- name: COMMUNICATION_OIDC_ISSUER
  value: {{ .Values.oidc.issuer | quote }}
- name: COMMUNICATION_OIDC_CLIENT_ID
  value: {{ .Values.oidc.clientId | quote }}
{{- if .Values.oidc.clientSecret.name }}
- name: COMMUNICATION_OIDC_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ .Values.oidc.clientSecret.name }}
      key: {{ .Values.oidc.clientSecret.key }}
{{- end }}
{{- end }}
{{- if .Values.devLogin }}
# devLogin: the lab's dev-login env (mock IdP + insecure cookie + a seeded
# bootstrap admin). NEVER IN PRODUCTION: this sets the Secure cookie flag off
# (ADR-0012 § 5).
- name: COMMUNICATION_COOKIE_SECURE
  value: "false"
- name: COMMUNICATION_BOOTSTRAP_ADMIN_SUBJECTS
  value: {{ .Values.devLoginSubject | quote }}
{{- end }}
{{- if .Values.keyringSecret }}
- name: COMMUNICATION_SECRET_KEYRING
  value: /keyring/ring
{{- end }}
- name: COMMUNICATION_ARTIFACT_BACKEND
  value: "local"
- name: COMMUNICATION_ARTIFACT_ROOT
  value: "/data/artifacts"
# The image's own HOME is not writable by uid 10001 at runtime.
- name: HOME
  value: "/home/worker"
{{- with .Values.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/*
Control-plane environment *without* the shared block: `dev` composes
envServe + envWorker + envCommon, split serve composes envServe + envCommon.
*/}}
{{- define "communication.envServe" -}}
- name: COMMUNICATION_LISTEN_ADDR
  value: ":8080"
- name: COMMUNICATION_REPLICA_NAME
  valueFrom:
    fieldRef:
      fieldPath: metadata.name
{{- end -}}

{{/*
Execution-plane environment. The three sandbox directories are SIBLINGS of the
storage roots, never children: nono derives its protected state root from HOME
and thereafter permanently refuses every grant that overlaps it (probe C-H1;
docs/research/2026-11-k8s-run-modes.md § 1, cmd/communication/worker.go:1185-1194).
*/}}
{{- define "communication.envWorker" -}}
- name: COMMUNICATION_WORKER_NAME
  valueFrom:
    fieldRef:
      fieldPath: metadata.name
- name: COMMUNICATION_WORKER_CAPACITY
  value: {{ .Values.worker.capacity | quote }}
- name: COMMUNICATION_WORKSPACE_ROOT
  value: "/data/workspaces"
- name: COMMUNICATION_REPOS_ROOT
  value: "/data/repos"
- name: COMMUNICATION_SANDBOX_ENFORCEMENT
  value: {{ .Values.worker.enforcement | quote }}
- name: COMMUNICATION_SANDBOX_HOME
  value: "/sandbox-home"
- name: COMMUNICATION_SANDBOX_POLICY_DIR
  value: "/sandbox-policy"
- name: COMMUNICATION_SANDBOX_SELFTEST_DIR
  value: "/sandbox-selftest"
# Required in `required` mode: the agent's HOME has no global git config
# (GIT_CONFIG_NOSYSTEM), so an unset identity fails the agent's own `git commit`.
- name: COMMUNICATION_AGENT_GIT_NAME
  value: "Communication Worker"
- name: COMMUNICATION_AGENT_GIT_EMAIL
  value: "worker@communication.invalid"
{{- end -}}

{{/*
Launcher-seam environment, only with the pod launcher (ADR-0082 Decision 8).
*/}}
{{- define "communication.envLauncher" -}}
{{- if eq .Values.worker.launcher "kubernetes" }}
# ADR-0082 Decision 8: the launcher seam, its namespace, and the downward-API
# node pin the attempt pod is created on (Decision 4, v1 single-node).
- name: COMMUNICATION_WORKER_LAUNCHER
  value: "kubernetes"
- name: COMMUNICATION_AGENT_NAMESPACE
  value: {{ .Values.worker.agentNamespace | quote }}
- name: COMMUNICATION_AGENT_POD_IMAGE
  value: {{ include "communication.workerImage" . | quote }}
- name: COMMUNICATION_AGENT_POD_NODE
  valueFrom:
    fieldRef:
      fieldPath: spec.nodeName
{{- end }}
{{- end -}}

{{/*
Volumes every Communication pod needs.
*/}}
{{- define "communication.volumesCommon" -}}
- name: home
  emptyDir: {}
{{- if .Values.keyringSecret }}
- name: keyring-src
  secret:
    secretName: {{ .Values.keyringSecret }}
    defaultMode: 0400
- name: keyring
  emptyDir:
    medium: Memory
    sizeLimit: 1Mi
{{- end }}
{{- end -}}

{{/*
Volumes for a pod that touches the workspace tree (single, and the split-mode
worker): one claim plus the sibling sandbox directories.
*/}}
{{- define "communication.volumesWorker" -}}
- name: data
  persistentVolumeClaim:
    claimName: {{ include "communication.pvcName" . }}
- name: sandbox-home
  emptyDir: {}
- name: sandbox-policy
  emptyDir: {}
- name: sandbox-selftest
  emptyDir: {}
{{ include "communication.volumesCommon" . }}
{{- end -}}

{{/*
Mounts for a pod that runs the execution plane. The worker is the single
read-write writer of the artifact tree (ADR-0020 D2), so it mounts all three
roots of the one claim read-write, plus the sibling sandbox directories.
*/}}
{{- define "communication.volumeMountsWorker" -}}
- name: data
  mountPath: /data/workspaces
  subPath: workspaces
- name: data
  mountPath: /data/repos
  subPath: repos
- name: data
  mountPath: /data/artifacts
  subPath: artifacts
{{- if .Values.keyringSecret }}
- name: keyring
  mountPath: /keyring
  readOnly: true
{{- end }}
- name: home
  mountPath: /home/worker
- name: sandbox-home
  mountPath: /sandbox-home
- name: sandbox-policy
  mountPath: /sandbox-policy
- name: sandbox-selftest
  mountPath: /sandbox-selftest
{{- end -}}

{{/*
Mounts the serving half needs: the artifact volume READ-ONLY (one writer, many
readers — ADR-0020 D2) and the keyring.
*/}}
{{- define "communication.volumeMountsServe" -}}
- name: data
  mountPath: /data/artifacts
  subPath: artifacts
  readOnly: true
{{- if .Values.keyringSecret }}
- name: keyring
  mountPath: /keyring
  readOnly: true
{{- end }}
- name: home
  mountPath: /home/worker
{{- end -}}

{{/*
One-shot that copies the keyring into a 0700 emptyDir as a 0600 regular file
(the home manifest's pattern: LoadKeyring refuses the Secret volume's symlinks
and group bits; the emptyDir root is root-owned, hence the owned subdir).
*/}}
{{- define "communication.keyringInitContainer" -}}
{{- if .Values.keyringSecret }}
- name: keyring
  image: {{ include "communication.initImage" . }}
  imagePullPolicy: {{ include "communication.initImagePullPolicy" . }}
  command: ["sh", "-ec"]
  args:
    - |
      umask 077
      mkdir -p /keyring/ring
      chmod 700 /keyring/ring
      cp /keyring-src/master-key-v1 /keyring/ring/master-key-v1
      chmod 600 /keyring/ring/master-key-v1
  securityContext:
    allowPrivilegeEscalation: false
    capabilities:
      drop: [ALL]
  resources:
    requests:
      cpu: 10m
      memory: 16Mi
    limits:
      cpu: 100m
      memory: 64Mi
  volumeMounts:
    - name: keyring-src
      mountPath: /keyring-src
      readOnly: true
    - name: keyring
      mountPath: /keyring
{{- end }}
{{- end -}}

{{/*
One-shot schema migration (ADR-0013: serve never migrates itself; it refuses
readiness until the schema is current).
*/}}
{{- define "communication.migrateInitContainer" -}}
- name: migrate
  image: {{ include "communication.initImage" . }}
  imagePullPolicy: {{ include "communication.initImagePullPolicy" . }}
  args: ["migrate", "up"]
  securityContext:
    allowPrivilegeEscalation: false
    capabilities:
      drop: [ALL]
  resources:
    requests:
      cpu: 10m
      memory: 32Mi
    limits:
      cpu: 500m
      memory: 256Mi
  env:
    - name: COMMUNICATION_DATABASE_URL
      valueFrom:
        secretKeyRef:
          name: {{ .Values.database.urlSecret.name }}
          key: {{ .Values.database.urlSecret.key }}
{{- end -}}

{{/*
The PVC name: one claim, three subPaths (workspaces/repos/artifacts), so the
storage roots stay siblings inside a single volume (ADR-0082 Decision 1).
*/}}
{{- define "communication.pvcName" -}}
{{ printf "%s-data" (include "communication.fullname" .) }}
{{- end -}}

{{/*
Scheduling pins: exposed, never defaulted (research § 4).
*/}}
{{- define "communication.scheduling" -}}
{{- with .Values.nodeSelector }}
nodeSelector:
{{ toYaml . }}
{{- end }}
{{- with .Values.tolerations }}
tolerations:
{{ toYaml . }}
{{- end }}
{{- with .Values.affinity }}
affinity:
{{ toYaml . }}
{{- end }}
{{- end -}}
