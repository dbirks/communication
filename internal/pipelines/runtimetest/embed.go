package runtimetest

import (
	_ "embed"
)

// Embedded fixtures (see the header of runtimetest.go for why the plans are
// authored documents compiled through the publish path, not Go structs).
var (
	//go:embed testdata/conform-single.yaml
	singleYAML []byte
	//go:embed testdata/conform-retry.yaml
	retryYAML []byte
	//go:embed testdata/conform-gate.yaml
	gateYAML []byte
)

func pipelineYAML(name Pipeline) []byte {
	switch name {
	case PipelineSingle:
		return singleYAML
	case PipelineRetry:
		return retryYAML
	case PipelineGate:
		return gateYAML
	}
	return nil
}
