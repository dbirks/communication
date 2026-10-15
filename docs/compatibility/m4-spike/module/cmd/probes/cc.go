//go:build ignore

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"

	santhosh "github.com/santhosh-tekuri/jsonschema/v6"
)

func main() {
	src, _ := os.ReadFile(os.Args[1])
	var doc any
	dec := json.NewDecoder(bytes.NewReader(src))
	dec.UseNumber()
	dec.Decode(&doc)
	c := santhosh.NewCompiler()
	id := doc.(map[string]any)["$id"].(string)
	if err := c.AddResource(id, doc); err != nil {
		panic(err)
	}
	if _, err := c.Compile(id); err != nil {
		fmt.Printf("FULL: %v\n", err)
		return
	}
	fmt.Println("compiles")
}
