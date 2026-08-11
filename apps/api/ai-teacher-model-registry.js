'use strict';

const crypto = require('crypto');

function modelRegistryFromLiteLlmVersion(version = {}) {
  const groups = Array.isArray(version?.config?.modelGroups) ? version.config.modelGroups : [];
  const profiles = groups.flatMap((group) => {
    const alias = String(group?.modelName || '').trim();
    const deployments = Array.isArray(group?.deployments)
      ? group.deployments.filter((deployment) => deployment?.enabled !== false)
      : [];
    if (!alias || !deployments.length) return [];
    const providers = [...new Set(deployments.map((deployment) => String(deployment?.provider || '').trim()).filter(Boolean))].sort();
    return [{
      profileId: `model_profile_${shortHash(`${version.versionId || ''}\n${alias}`)}`,
      litellmAlias: alias,
      displayName: alias,
      status: 'registered',
      capabilityStatus: 'not_probed',
      deploymentCount: deployments.length,
      providers
    }];
  }).sort((left, right) => left.litellmAlias.localeCompare(right.litellmAlias));
  return {
    registryRevision: String(version?.versionId || ''),
    registryChecksum: String(version?.checksum || ''),
    source: 'active_litellm_config',
    aliases: profiles.map((profile) => profile.litellmAlias),
    profiles
  };
}

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 24);
}

module.exports = {
  modelRegistryFromLiteLlmVersion
};
