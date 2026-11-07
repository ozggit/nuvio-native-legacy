#include "pcaudio.h"
#include "rede.h"
#include "js.h"
#include <assert.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static pthread_mutex_t mockLock = PTHREAD_MUTEX_INITIALIZER;
static char currentId[33], currentSource[4096], stored[256];
static unsigned creates, deletes;
char *dados_ler(const char *name) { (void)name; return stored[0] ? strdup(stored) : NULL; }
int dados_gravar(const char *name,const char *s) { assert(!strcmp(name,"pcaudio-local.txt")); snprintf(stored,sizeof stored,"%s",s);return 1; }
char *dados_caminho(char *dst,unsigned n,const char *name) { (void)dst;(void)n;(void)name;return NULL; }
int rede_pedir(const RedePedido *p,RedeResposta *r) {
  memset(r,0,sizeof *r); r->status=200;
  const char *id=strrchr(p->url,'/')+1;
  assert(strlen(id)==32);assert(p->seguir==0);assert(p->cabecalhos[0]);
  pthread_mutex_lock(&mockLock);
  if (!strcmp(p->metodo,"PUT")) {
    snprintf(currentId,sizeof currentId,"%s",id);
    assert(js_texto_raiz(p->corpo,"url",currentSource,sizeof currentSource));
    char headers[256];assert(js_texto_linhas(p->corpo,NULL,"headers",headers,sizeof headers));
    assert(!strcmp(headers,"Authorization: Bearer test\r\n"));creates++;
    r->corpo=strdup("{\"state\":\"preparing\"}");
  } else if (!strcmp(p->metodo,"DELETE")) {
    deletes++;if(!strcmp(currentId,id))currentId[0]=0;
    r->corpo=strdup("{}");
  } else {
    // Force a stale reply to arrive after the UI selects another source.
    char source[4096];snprintf(source,sizeof source,"%s",currentSource);
    pthread_mutex_unlock(&mockLock);
    usleep(strstr(source,"slow")?300000:10000);
    pthread_mutex_lock(&mockLock);
    char body[600];
    snprintf(body,sizeof body,"{\"state\":\"ready\",\"mode\":\"pc\",\"duration\":100,\"start\":4,\"path\":\"/v1/media/%s/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/stream.ts\"}",id);
    r->corpo=strdup(body);
  }
  pthread_mutex_unlock(&mockLock);r->n_corpo=strlen(r->corpo);return 1;
}
void rede_resposta_limpar(RedeResposta *r) { free(r->corpo);free(r->cabecalhos);memset(r,0,sizeof *r); }
static PcAudioResult waitResult(void) {
  PcAudioResult result;
  for(int n=0;n<300;n++){if(pcaudio_receber(&result))return result;usleep(10000);}
  assert(!"timed out waiting for native worker");return (PcAudioResult){0};
}
int main(void) {
  const char *pair="http://192.168.1.10:8787#0123456789abcdef0123456789abcdef0123456789abcdef";
  assert(!pcaudio_configurar("http://example.com:8787#bad"));
  assert(!pcaudio_configurar("http://127.0.0.1:8787#0123456789abcdef0123456789abcdef0123456789abcdef"));
  assert(pcaudio_configurar(pair));assert(pcaudio_configurado());
  assert(!strchr(pcaudio_servidor(),'#'));
  pcaudio_armar(1);assert(pcaudio_consumir());assert(!pcaudio_consumir());
  assert(pcaudio_iniciar("https://example.com/slow?quote=\"x\"","Authorization: Bearer test\r\n",0));
  usleep(50000);
  assert(pcaudio_iniciar("https://example.com/new","Authorization: Bearer test\r\n",4));
  PcAudioResult r=waitResult();assert(r.pc&&!r.error[0]);assert(r.duration==100&&r.start==4);
  pthread_mutex_lock(&mockLock);assert(strstr(r.url,currentId));assert(creates==2&&deletes>=1);pthread_mutex_unlock(&mockLock);
  assert(pcaudio_ativo()&&!pcaudio_pendente());
  assert(pcaudio_buscar(40));r=waitResult();assert(r.pc);
  pcaudio_parar();assert(!pcaudio_ativo());assert(!pcaudio_receber(&r));
  assert(pcaudio_iniciar("https://example.com/slow","Authorization: Bearer test\r\n",0));
  usleep(50000); assert(pcaudio_pendente()); pcaudio_parar();
  assert(!pcaudio_ativo() && !pcaudio_pendente());
  usleep(400000);
  assert(!pcaudio_receber(&r));
  pthread_mutex_lock(&mockLock); assert(!currentId[0]); pthread_mutex_unlock(&mockLock);
  /* Back from PC loading then choose a different source: no stale result. */
  assert(pcaudio_iniciar("https://example.com/after-back","Authorization: Bearer test\r\n",0));
  r = waitResult(); assert(r.pc && !r.error[0]);
  pthread_mutex_lock(&mockLock); assert(strstr(currentSource,"after-back")); pthread_mutex_unlock(&mockLock);
  pcaudio_parar();
  pcaudio_falhar("explicit error");assert(pcaudio_ativo());r=waitResult();assert(!strcmp(r.error,"explicit error"));
  assert(pcaudio_configurar(""));assert(!pcaudio_configurado());
  puts("PASS: pairing, escaped headers, stale reply rejection, seek, stop, explicit error");
  return 0;
}
